import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { applyPatch as applyUnifiedPatch, parsePatch } from "diff";
import Fuse from "fuse.js";

import { defineTool } from "../tools/define";
import type { ToolContext, ToolResult } from "../tools/types";
import {
  atomicWrite,
  clampLineRange,
  detectFrameworks,
  fileVersion,
  importantFiles,
  languageForPath,
  lineOffsets,
  listEntries,
  readTextFile,
  removeFile,
  renderLineRange,
} from "./files";
import { diffStatus as gitDiffStatus } from "./git";
import {
  FilesystemAccessError,
  displayPath,
  normalizeFilesystemPolicy,
  normalizePathForOutput,
  resolvePath,
  resolveRoot,
} from "./policy";
import { SCHEMAS } from "./schemas";
import {
  searchSemantic as runSemanticSearch,
  searchText as runTextSearch,
} from "./search";
import { symbolsForFile, symbolsForPath } from "./symbols";
import type {
  ApplyPatchArgs,
  DiffStatusArgs,
  EditRangeArgs,
  EditReplaceArgs,
  FilesystemTools,
  FilesystemToolsConfig,
  FindFilesArgs,
  OpenWindowArgs,
  ReadArgs,
  RepoMapArgs,
  SearchSemanticArgs,
  SearchTextArgs,
  SymbolsArgs,
  ValidationOptions,
  WriteFileArgs,
} from "./types";

function fail(error: unknown): ToolResult {
  if (error instanceof FilesystemAccessError)
    return { ok: false, error: error.message };
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value ?? fallback;
  return Math.max(min, Math.min(max, n));
}

function countLanguages(
  entries: readonly { readonly relativePath: string; readonly type: string }[],
) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const language = languageForPath(entry.relativePath);
    if (language !== undefined)
      counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

function depthOf(path: string): number {
  return path === "." ? 0 : path.split("/").filter(Boolean).length;
}

function modeFor(
  query: string,
  mode: FindFilesArgs["mode"],
): Exclude<FindFilesArgs["mode"], undefined | "auto"> {
  if (mode !== undefined && mode !== "auto") return mode;
  if (/[\\/[*?\]]/.test(query))
    return query.includes("*") || query.includes("?") ? "glob" : "exact";
  if (query.startsWith(".") || /^[A-Za-z0-9]+$/.test(query)) return "fuzzy";
  return "fuzzy";
}

function resultEntry(
  root: string,
  path: string,
  type: string,
  size: number,
  score?: number,
) {
  return {
    path: displayPath(root, path),
    absolutePath: path,
    type,
    size,
    ...(score !== undefined ? { score } : {}),
  };
}

function collapseLines(
  lines: readonly string[],
  options: { collapseImports: boolean; collapseComments: boolean },
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    if (options.collapseImports && /^\s*import\b/.test(text)) {
      const start = i;
      while (i + 1 < lines.length && /^\s*import\b/.test(lines[i + 1] ?? ""))
        i += 1;
      out.push({
        line: start + 1,
        text: `[imports collapsed: ${i - start + 1} lines]`,
      });
      continue;
    }
    if (options.collapseComments && /^\s*(\/\/|\/\*|\*|#)/.test(text)) {
      const start = i;
      while (
        i + 1 < lines.length &&
        /^\s*(\/\/|\/\*|\*|#)/.test(lines[i + 1] ?? "")
      )
        i += 1;
      out.push({
        line: start + 1,
        text: `[comments collapsed: ${i - start + 1} lines]`,
      });
      continue;
    }
    out.push({ line: i + 1, text });
  }
  return out;
}

function renderCollapsedLineRange(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  includeLineNumbers: boolean,
  options: { collapseImports: boolean; collapseComments: boolean },
): string {
  const collapsed = collapseLines(lines.slice(startLine - 1, endLine), options);
  if (!includeLineNumbers) return collapsed.map((line) => line.text).join("\n");
  return collapsed
    .map((line) => `${startLine + line.line - 1}: ${line.text}`)
    .join("\n");
}

async function syntaxCheck(
  path: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const ext = extname(path).toLowerCase();
  try {
    if (ext === ".json") JSON.parse(content);
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const ts = await import("typescript");
      const diagnostics =
        ts.transpileModule(content, {
          compilerOptions: { noEmit: true },
          reportDiagnostics: true,
        }).diagnostics ?? [];
      const first = diagnostics.find(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (first !== undefined) {
        return {
          ok: false,
          error: ts.flattenDiagnosticMessageText(first.messageText, "\n"),
        };
      }
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runValidation(
  config: FilesystemToolsConfig,
  validate: ValidationOptions | undefined,
  changedFiles: readonly { readonly path: string; readonly content: string }[],
  cwd: string,
  ctx: ToolContext,
) {
  const options = validate ?? {};
  const syntax = options.syntax ?? true;
  const syntaxResults = [];
  if (syntax) {
    for (const file of changedFiles) {
      syntaxResults.push({
        path: file.path,
        ...(await syntaxCheck(file.path, file.content)),
      });
    }
  }

  const tests = [];
  for (const command of options.tests ?? []) {
    if (config.runValidationCommand === undefined) {
      tests.push({
        command,
        ok: false,
        skipped: true,
        reason: "no runValidationCommand hook configured",
      });
      continue;
    }
    tests.push(
      await config.runValidationCommand(command, {
        cwd,
        changedFiles: changedFiles.map((file) => file.path),
        ctx,
      }),
    );
  }

  return {
    syntax: syntaxResults,
    ...(options.format === true
      ? {
          format: {
            ok: false,
            skipped: true,
            reason: "no formatter hook configured",
          },
        }
      : {}),
    tests,
  };
}

async function readWholeFile(
  path: string,
  maxBytes: number,
): Promise<{ text: string; version: string }> {
  const info = await stat(path);
  if (info.size > maxBytes) {
    throw new FilesystemAccessError(
      `file ${JSON.stringify(path)} exceeds max write/read size`,
    );
  }
  const bytes = await readFile(path);
  return { text: bytes.toString("utf8"), version: fileVersion(bytes) };
}

function checkExpectedVersion(
  current: string,
  expected: string | undefined,
): ToolResult | null {
  if (expected !== undefined && expected !== current) {
    return {
      ok: false,
      error: `file version mismatch: expected ${expected}, got ${current}`,
    };
  }
  return null;
}

function stripPatchPath(path: string | undefined): string | null {
  if (path === undefined || path === "/dev/null") return null;
  return normalizePathForOutput(path).replace(/^a\//, "").replace(/^b\//, "");
}

export function filesystemTools(
  config: FilesystemToolsConfig,
): FilesystemTools {
  const policy = normalizeFilesystemPolicy(config);

  const repoMap = defineTool<RepoMapArgs>({
    name: "repo_map",
    description:
      "Compact repository overview with directory tree, important files, languages, frameworks, and optional symbols.",
    parameters: SCHEMAS.repoMap,
    async execute(args) {
      try {
        const root = await resolveRoot(policy, args.root);
        const depth = bounded(args.depth, 3, 1, 6);
        const maxEntries = bounded(
          args.max_entries,
          policy.maxEntries,
          1,
          10_000,
        );
        const listed = await listEntries(root.path, {
          includeFiles: args.include_files ?? true,
          respectGitignore: args.respect_gitignore ?? true,
          maxEntries,
        });
        const visible = listed.entries.filter(
          (entry) => depthOf(entry.relativePath) <= depth,
        );
        const symbols =
          args.include_symbols === true
            ? (
                await symbolsForPath(policy, root.path, {
                  recursive: true,
                  maxResults: 100,
                })
              ).results
            : undefined;
        return {
          ok: true,
          content: {
            root: root.path,
            tree: visible.map((entry) => ({
              path: entry.relativePath,
              type: entry.type,
              size: entry.type === "file" ? entry.size : undefined,
              language:
                entry.type === "file"
                  ? languageForPath(entry.relativePath)
                  : undefined,
            })),
            importantFiles: importantFiles(listed.entries),
            languages: countLanguages(listed.entries),
            frameworks: detectFrameworks(listed.entries),
            truncated:
              listed.truncated || visible.length < listed.entries.length,
            totalEntries: listed.total,
            ...(symbols !== undefined ? { symbols } : {}),
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const findFiles = defineTool<FindFilesArgs>({
    name: "find_files",
    description:
      "Find files by exact path, glob, fuzzy name, extension, or regex path pattern.",
    parameters: SCHEMAS.findFiles,
    async execute(args) {
      try {
        const root = await resolveRoot(policy, args.root);
        const maxResults = bounded(
          args.max_results,
          policy.maxResults,
          1,
          1000,
        );
        const mode = modeFor(args.query, args.mode);

        if (mode === "exact") {
          const resolved = await resolvePath(policy, args.query, {
            base: root.path,
            mustExist: true,
          });
          const info = await lstat(resolved.path);
          return {
            ok: true,
            content: {
              root: root.path,
              mode,
              results: [
                resultEntry(
                  root.path,
                  resolved.path,
                  info.isDirectory() ? "directory" : "file",
                  info.size,
                ),
              ],
              truncated: false,
            },
          };
        }

        const listed = await listEntries(root.path, {
          includeHidden: args.include_hidden ?? false,
          respectGitignore: args.respect_gitignore ?? true,
          maxEntries: Number.POSITIVE_INFINITY,
          includeGlobs: mode === "glob" ? [args.query] : undefined,
        });
        let matches = listed.entries;
        if (mode === "extension") {
          const ext = args.query.startsWith(".")
            ? args.query
            : `.${args.query}`;
          matches = matches.filter(
            (entry) =>
              entry.type === "file" && extname(entry.relativePath) === ext,
          );
        } else if (mode === "regex") {
          const regex = new RegExp(args.query);
          matches = matches.filter((entry) => regex.test(entry.relativePath));
        } else if (mode === "fuzzy") {
          const fuse = new Fuse(matches, {
            keys: ["relativePath"],
            includeScore: true,
            threshold: 0.45,
          });
          const ranked = fuse.search(args.query).slice(0, maxResults);
          return {
            ok: true,
            content: {
              root: root.path,
              mode,
              results: ranked.map((item) =>
                resultEntry(
                  root.path,
                  item.item.path,
                  item.item.type,
                  item.item.size,
                  item.score,
                ),
              ),
              truncated:
                ranked.length < matches.length && ranked.length >= maxResults,
            },
          };
        }

        return {
          ok: true,
          content: {
            root: root.path,
            mode,
            results: matches
              .slice(0, maxResults)
              .map((entry) =>
                resultEntry(root.path, entry.path, entry.type, entry.size),
              ),
            truncated: matches.length > maxResults,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const searchText = defineTool<SearchTextArgs>({
    name: "search_text",
    description:
      "Search file contents using literal text or regex and return compact previews.",
    parameters: SCHEMAS.searchText,
    async execute(args) {
      try {
        const root = await resolveRoot(policy, args.root);
        const result = await runTextSearch(root.path, {
          pattern: args.pattern,
          mode: args.mode ?? "literal",
          includeGlobs: args.include_globs,
          excludeGlobs: args.exclude_globs,
          caseSensitive: args.case_sensitive ?? false,
          contextLines: bounded(args.context_lines, 2, 0, 10),
          maxResults: bounded(args.max_results, policy.maxResults, 1, 1000),
          maxPreviewChars: bounded(
            args.max_preview_chars,
            12_000,
            100,
            100_000,
          ),
        });
        return { ok: true, content: { root: root.path, ...result } };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const searchSemantic = defineTool<SearchSemanticArgs>({
    name: "search_semantic",
    description:
      "Find relevant files, chunks, or symbols from a natural-language code query.",
    parameters: SCHEMAS.searchSemantic,
    async execute(args) {
      try {
        const root = await resolveRoot(policy, args.root);
        const result = await runSemanticSearch(root.path, {
          query: args.query,
          includeGlobs: args.include_globs,
          excludeGlobs: args.exclude_globs,
          granularity: args.granularity ?? "chunk",
          maxResults: bounded(args.max_results, 20, 1, 1000),
          maxPreviewChars: bounded(
            args.max_preview_chars,
            12_000,
            100,
            100_000,
          ),
        });
        return {
          ok: true,
          content: { root: root.path, backend: "minisearch", ...result },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const symbols = defineTool<SymbolsArgs>({
    name: "symbols",
    description:
      "Return compact symbols, imports, exports, and line ranges for a file or directory.",
    parameters: SCHEMAS.symbols,
    async execute(args) {
      try {
        const result = await symbolsForPath(policy, args.path, {
          recursive: args.recursive ?? false,
          kinds: args.symbol_kinds,
          maxResults: bounded(args.max_results, 200, 1, 5000),
        });
        return { ok: true, content: result };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const read = defineTool<ReadArgs>({
    name: "read",
    description:
      "Read exact line ranges or symbol ranges with line numbers and token-aware limits.",
    parameters: SCHEMAS.read,
    async execute(args) {
      try {
        const resolved = await resolvePath(policy, args.path, {
          mustExist: true,
        });
        const maxBytes = bounded(
          args.max_bytes,
          policy.maxReadBytes,
          1,
          policy.maxWriteBytes,
        );
        const file = await readTextFile(resolved.path, maxBytes);
        const lines = lineOffsets(file.text);
        let range = clampLineRange(
          lines.length,
          args.start_line,
          args.end_line,
        );
        if (args.symbol !== undefined) {
          const found = (
            await symbolsForFile(resolved.path, resolved.root, maxBytes)
          ).find((symbol) => symbol.name === args.symbol);
          if (found === undefined)
            return {
              ok: false,
              error: `symbol ${JSON.stringify(args.symbol)} not found`,
            };
          range = { startLine: found.startLine, endLine: found.endLine };
        }
        return {
          ok: true,
          content: {
            path: displayPath(resolved.root, resolved.path),
            absolutePath: resolved.path,
            fileVersion: file.version,
            startLine: range.startLine,
            endLine: range.endLine,
            totalLines: lines.length,
            truncated: file.truncated,
            content: renderCollapsedLineRange(
              lines,
              range.startLine,
              range.endLine,
              args.include_line_numbers ?? true,
              {
                collapseImports: args.collapse_imports ?? false,
                collapseComments: args.collapse_comments ?? false,
              },
            ),
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const openWindow = defineTool<OpenWindowArgs>({
    name: "open_window",
    description: "Open or scroll a token-limited viewing window over a file.",
    parameters: SCHEMAS.openWindow,
    async execute(args) {
      try {
        const resolved = await resolvePath(policy, args.path, {
          mustExist: true,
        });
        const file = await readTextFile(resolved.path, policy.maxReadBytes);
        const lines = lineOffsets(file.text);
        const windowLines = bounded(args.window_lines, 100, 20, 200);
        let anchorLine = 1;
        if (typeof args.anchor === "number") {
          anchorLine = args.anchor;
        } else if (typeof args.anchor === "string") {
          const symbol = (
            await symbolsForFile(
              resolved.path,
              resolved.root,
              policy.maxReadBytes,
            )
          ).find((item) => item.name === args.anchor);
          anchorLine =
            symbol?.startLine ??
            Math.max(
              1,
              lines.findIndex((line) => line.includes(args.anchor as string)) +
                1,
            );
        }

        const direction = args.direction ?? "center";
        const start =
          direction === "next"
            ? anchorLine + 1
            : direction === "prev"
              ? anchorLine - windowLines
              : anchorLine - Math.floor(windowLines / 2);
        const range = clampLineRange(
          lines.length,
          start,
          start + windowLines - 1,
        );
        return {
          ok: true,
          content: {
            path: displayPath(resolved.root, resolved.path),
            absolutePath: resolved.path,
            fileVersion: file.version,
            anchorLine,
            startLine: range.startLine,
            endLine: range.endLine,
            totalLines: lines.length,
            content: renderLineRange(
              lines,
              range.startLine,
              range.endLine,
              true,
            ),
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const editReplace = defineTool<EditReplaceArgs>({
    name: "edit_replace",
    description:
      "Replace exact text in a file with concurrency checks and mismatch diagnostics.",
    parameters: SCHEMAS.editReplace,
    async execute(args, ctx) {
      try {
        const resolved = await resolvePath(policy, args.path, {
          mustExist: true,
        });
        const current = await readWholeFile(
          resolved.path,
          policy.maxWriteBytes,
        );
        const versionError = checkExpectedVersion(
          current.version,
          args.expected_file_version,
        );
        if (versionError !== null) return versionError;
        const occurrence = args.occurrence ?? 1;
        let index = -1;
        let from = 0;
        for (let i = 0; i < occurrence; i += 1) {
          index = current.text.indexOf(args.old_text, from);
          if (index === -1)
            return {
              ok: false,
              error: `old_text occurrence ${occurrence} not found`,
            };
          from = index + args.old_text.length;
        }
        const next = `${current.text.slice(0, index)}${args.new_text}${current.text.slice(index + args.old_text.length)}`;
        const nextVersion = await atomicWrite(resolved.path, next);
        const validation = await runValidation(
          config,
          args.validate,
          [{ path: resolved.path, content: next }],
          dirname(resolved.path),
          ctx,
        );
        return {
          ok: true,
          content: {
            path: displayPath(resolved.root, resolved.path),
            previousFileVersion: current.version,
            fileVersion: nextVersion,
            changed: true,
            validation,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const editRange = defineTool<EditRangeArgs>({
    name: "edit_range",
    description: "Replace a precise line range in a file.",
    parameters: SCHEMAS.editRange,
    async execute(args, ctx) {
      try {
        const resolved = await resolvePath(policy, args.path, {
          mustExist: true,
        });
        const current = await readWholeFile(
          resolved.path,
          policy.maxWriteBytes,
        );
        const versionError = checkExpectedVersion(
          current.version,
          args.expected_file_version,
        );
        if (versionError !== null) return versionError;
        const lines = lineOffsets(current.text);
        if (args.end_line < args.start_line)
          return { ok: false, error: "end_line must be >= start_line" };
        if (args.start_line > lines.length)
          return { ok: false, error: "start_line is beyond end of file" };
        const replacement = args.new_text.replace(/\r\n/g, "\n").split("\n");
        const nextLines = [
          ...lines.slice(0, args.start_line - 1),
          ...replacement,
          ...lines.slice(args.end_line),
        ];
        const next = nextLines.join("\n");
        const nextVersion = await atomicWrite(resolved.path, next);
        const validation = await runValidation(
          config,
          args.validate,
          [{ path: resolved.path, content: next }],
          dirname(resolved.path),
          ctx,
        );
        return {
          ok: true,
          content: {
            path: displayPath(resolved.root, resolved.path),
            previousFileVersion: current.version,
            fileVersion: nextVersion,
            changed: true,
            validation,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const applyPatch = defineTool<ApplyPatchArgs>({
    name: "apply_patch",
    description:
      "Apply a unified diff patch across one or more files with dry-run and validation support.",
    parameters: SCHEMAS.applyPatch,
    async execute(args, ctx) {
      try {
        const root = await resolveRoot(policy, args.root);
        const parsed = parsePatch(args.patch);
        if (parsed.length === 0)
          return { ok: false, error: "patch did not contain any file changes" };
        const dryRun = args.dry_run ?? false;
        const files = [];
        const changedFiles: Array<{ path: string; content: string }> = [];

        for (const patch of parsed) {
          const relPath =
            stripPatchPath(patch.newFileName) ??
            stripPatchPath(patch.oldFileName);
          if (relPath === null)
            return { ok: false, error: "patch file is missing a path" };
          const resolved = await resolvePath(policy, relPath, {
            base: root.path,
            forCreate: true,
          });
          const current = existsSync(resolved.path)
            ? await readWholeFile(resolved.path, policy.maxWriteBytes)
            : { text: "", version: fileVersion("") };
          const expected =
            args.expected_versions?.[relPath] ??
            args.expected_versions?.[displayPath(root.path, resolved.path)];
          const versionError = checkExpectedVersion(current.version, expected);
          if (versionError !== null) return versionError;
          const next = applyUnifiedPatch(current.text, patch, {
            autoConvertLineEndings: true,
          });
          if (next === false)
            return { ok: false, error: `patch failed to apply to ${relPath}` };
          const deleting = stripPatchPath(patch.newFileName) === null;
          if (!dryRun) {
            if (deleting) await removeFile(resolved.path);
            else await atomicWrite(resolved.path, next);
          }
          if (!deleting)
            changedFiles.push({ path: resolved.path, content: next });
          files.push({
            path: relPath,
            changed: true,
            deleted: deleting,
            previousFileVersion: current.version,
            fileVersion: deleting ? undefined : fileVersion(next),
          });
        }

        const validation = dryRun
          ? undefined
          : await runValidation(
              config,
              args.validate,
              changedFiles,
              root.path,
              ctx,
            );
        return {
          ok: true,
          content: { root: root.path, dryRun, files, validation },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const writeFileTool = defineTool<WriteFileArgs>({
    name: "write_file",
    description:
      "Create, append, or overwrite a file. Prefer patch/range/replace edits for existing files.",
    parameters: SCHEMAS.writeFile,
    async execute(args) {
      try {
        if (Buffer.byteLength(args.content, "utf8") > policy.maxWriteBytes) {
          return { ok: false, error: "content exceeds maxWriteBytes" };
        }
        const resolved = await resolvePath(policy, args.path, {
          forCreate: true,
        });
        const mode = args.mode ?? "create_only";
        const exists = existsSync(resolved.path);
        if (mode === "create_only" && exists)
          return { ok: false, error: "file already exists" };
        if (
          (args.create_dirs ?? true) === false &&
          !existsSync(dirname(resolved.path))
        ) {
          return { ok: false, error: "parent directory does not exist" };
        }
        let previousFileVersion: string | undefined;
        let next = args.content;
        if (exists) {
          const current = await readWholeFile(
            resolved.path,
            policy.maxWriteBytes,
          );
          previousFileVersion = current.version;
          const versionError = checkExpectedVersion(
            current.version,
            args.expected_file_version,
          );
          if (versionError !== null) return versionError;
          if (mode === "append") next = current.text + args.content;
        }
        if (Buffer.byteLength(next, "utf8") > policy.maxWriteBytes) {
          return { ok: false, error: "resulting file exceeds maxWriteBytes" };
        }
        if ((args.create_dirs ?? true) === true)
          await mkdir(dirname(resolved.path), { recursive: true });
        const nextVersion = await atomicWrite(resolved.path, next);
        return {
          ok: true,
          content: {
            path: displayPath(resolved.root, resolved.path),
            previousFileVersion,
            fileVersion: nextVersion,
            mode,
            changed: true,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  });

  const diffStatus = defineTool<DiffStatusArgs>({
    name: "diff_status",
    description: "Return compact Git-style status and diffs for changed files.",
    parameters: SCHEMAS.diffStatus,
    async execute(args) {
      try {
        const paths = [];
        for (const path of args.paths ?? []) {
          const resolved = await resolvePath(policy, path, {
            mustExist: false,
          });
          paths.push(displayPath(policy.defaultRoot, resolved.path));
        }
        const result = await gitDiffStatus(policy.defaultRoot, {
          paths,
          includeDiff: args.include_diff ?? true,
          maxDiffChars: bounded(args.max_diff_chars, 20_000, 100, 1_000_000),
          contextLines: bounded(args.context_lines, 3, 0, 20),
        });
        return { ok: true, content: { root: policy.defaultRoot, ...result } };
      } catch (err) {
        return fail(err);
      }
    },
  });

  return {
    repoMap,
    findFiles,
    searchText,
    searchSemantic,
    symbols,
    read,
    openWindow,
    editReplace,
    editRange,
    applyPatch,
    writeFile: writeFileTool,
    diffStatus,
  };
}
