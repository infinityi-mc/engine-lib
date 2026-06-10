import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

import MiniSearch from "minisearch";

import { isProbablyTextPath, lineOffsets, listEntries, readTextFile } from "./files";

export interface TextSearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly context: readonly { readonly line: number; readonly text: string; readonly match: boolean }[];
}

export interface SemanticSearchResult {
  readonly path: string;
  readonly score: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly preview: string;
  readonly symbol?: string;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 13))}\n[truncated]` : text;
}

function buildRegex(pattern: string, mode: "literal" | "regex", caseSensitive: boolean): RegExp {
  const source = mode === "literal" ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  return new RegExp(source, caseSensitive ? "g" : "gi");
}

function searchOneFile(
  text: string,
  relPath: string,
  regex: RegExp,
  contextLines: number,
  maxPreviewChars: number,
  maxResults: number,
): TextSearchResult[] {
  const lines = lineOffsets(text);
  const out: TextSearchResult[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    regex.lastIndex = 0;
    const match = regex.exec(line);
    if (match === null) continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const context = [];
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      context.push({
        line: lineIndex + 1,
        text: lines[lineIndex] ?? "",
        match: lineIndex === index,
      });
    }
    out.push({
      path: relPath,
      line: index + 1,
      column: match.index + 1,
      preview: truncate(line, maxPreviewChars),
      context,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

async function tryRipgrepSearch(options: {
  readonly root: string;
  readonly pattern: string;
  readonly mode: "literal" | "regex";
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly caseSensitive: boolean;
  readonly contextLines: number;
  readonly maxResults: number;
  readonly maxPreviewChars: number;
}): Promise<TextSearchResult[] | null> {
  try {
    const mod = await import("@vscode/ripgrep");
    const rgPath = (mod as { rgPath?: string }).rgPath;
    if (typeof rgPath !== "string") return null;
    const args = [
      "--json",
      "--color=never",
      "--line-number",
      "--column",
      "--context",
      String(options.contextLines),
      ...(options.caseSensitive ? [] : ["--ignore-case"]),
      ...(options.mode === "literal" ? ["--fixed-strings"] : []),
      ...((options.includeGlobs ?? []).flatMap((glob) => ["--glob", glob])),
      ...((options.excludeGlobs ?? []).flatMap((glob) => ["--glob", `!${glob}`])),
      "--",
      options.pattern,
      options.root,
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(rgPath, args, { cwd: options.root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || code === 1) resolve(out);
        else reject(new Error(err || `ripgrep exited ${code}`));
      });
    });
    const results: TextSearchResult[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
      if (raw.trim() === "") continue;
      const event = JSON.parse(raw) as {
        type: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          absolute_offset?: number;
          lines?: { text?: string };
          submatches?: readonly { start: number }[];
        };
      };
      if (event.type !== "match" || event.data === undefined) continue;
      const rawPath = event.data.path?.text ?? "";
      const path = isAbsolute(rawPath) ? relative(options.root, rawPath) : rawPath;
      const line = event.data.line_number ?? 1;
      const text = event.data.lines?.text?.replace(/\r?\n$/, "") ?? "";
      const column = (event.data.submatches?.[0]?.start ?? 0) + 1;
      results.push({
        path: path.replaceAll("\\", "/"),
        line,
        column,
        preview: truncate(text, options.maxPreviewChars),
        context: [{ line, text, match: true }],
      });
      if (results.length >= options.maxResults) break;
    }
    return results;
  } catch {
    return null;
  }
}

export async function searchText(root: string, options: {
  readonly pattern: string;
  readonly mode: "literal" | "regex";
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly caseSensitive: boolean;
  readonly contextLines: number;
  readonly maxResults: number;
  readonly maxPreviewChars: number;
}): Promise<{ readonly results: TextSearchResult[]; readonly backend: "ripgrep" | "node"; readonly truncated: boolean }> {
  const rg = await tryRipgrepSearch({ root, ...options });
  if (rg !== null) {
    return { results: rg, backend: "ripgrep", truncated: rg.length >= options.maxResults };
  }

  const files = await listEntries(root, {
    onlyFiles: true,
    respectGitignore: true,
    includeHidden: false,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    maxEntries: Number.POSITIVE_INFINITY,
  });
  const regex = buildRegex(options.pattern, options.mode, options.caseSensitive);
  const out: TextSearchResult[] = [];
  for (const entry of files.entries) {
    if (!isProbablyTextPath(entry.path)) continue;
    const text = await readFile(entry.path, "utf8").catch(() => "");
    out.push(...searchOneFile(
      text,
      entry.relativePath,
      regex,
      options.contextLines,
      options.maxPreviewChars,
      options.maxResults - out.length,
    ));
    if (out.length >= options.maxResults) break;
  }
  return { results: out, backend: "node", truncated: files.truncated || out.length >= options.maxResults };
}

function chunksForText(path: string, text: string, maxPreviewChars: number): SemanticSearchResult[] {
  const lines = lineOffsets(text);
  const chunks: SemanticSearchResult[] = [];
  const chunkSize = 40;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize);
    const preview = truncate(lines.slice(start, end).join("\n"), maxPreviewChars);
    chunks.push({ path, score: 0, startLine: start + 1, endLine: end, preview });
  }
  return chunks;
}

function symbolDocsForText(path: string, text: string, maxPreviewChars: number): SemanticSearchResult[] {
  const lines = lineOffsets(text);
  const out: SemanticSearchResult[] = [];
  const regex = /^\s*(?:export\s+)?(?:class|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((line, index) => {
    const match = regex.exec(line);
    if (match === null) return;
    out.push({
      path,
      score: 0,
      startLine: index + 1,
      endLine: index + 1,
      preview: truncate(line, maxPreviewChars),
      symbol: match[1],
    });
  });
  return out;
}

export async function searchSemantic(root: string, options: {
  readonly query: string;
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly granularity: "file" | "chunk" | "symbol";
  readonly maxResults: number;
  readonly maxPreviewChars: number;
}): Promise<{ readonly results: SemanticSearchResult[]; readonly truncated: boolean }> {
  const files = await listEntries(root, {
    onlyFiles: true,
    respectGitignore: true,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    maxEntries: Number.POSITIVE_INFINITY,
  });
  const docs: Array<SemanticSearchResult & { id: string; text: string }> = [];
  for (const entry of files.entries) {
    if (!isProbablyTextPath(entry.path)) continue;
    const text = (await readTextFile(entry.path, 200_000).catch(() => null))?.text;
    if (text === undefined) continue;
    if (options.granularity === "file") {
      docs.push({
        id: entry.relativePath,
        path: entry.relativePath,
        score: 0,
        startLine: 1,
        endLine: lineOffsets(text).length,
        preview: truncate(text, options.maxPreviewChars),
        text: `${entry.relativePath}\n${text}`,
      });
    } else {
      const units = options.granularity === "symbol"
        ? symbolDocsForText(entry.relativePath, text, options.maxPreviewChars)
        : chunksForText(entry.relativePath, text, options.maxPreviewChars);
      for (const chunk of units.length > 0 ? units : chunksForText(entry.relativePath, text, options.maxPreviewChars)) {
        docs.push({
          id: `${entry.relativePath}:${chunk.startLine}:${chunk.symbol ?? ""}`,
          ...chunk,
          text: `${entry.relativePath}\n${chunk.symbol ?? ""}\n${chunk.preview}`,
        });
      }
    }
  }
  if (docs.length === 0) return { results: [], truncated: false };

  const index = new MiniSearch({
    fields: ["path", "text", "symbol"],
    storeFields: ["path", "startLine", "endLine", "preview", "symbol"],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  });
  index.addAll(docs);
  const matches = index.search(options.query).slice(0, options.maxResults);
  return {
    results: matches.map((match) => ({
      path: String(match.path),
      score: match.score,
      startLine: Number(match.startLine),
      endLine: Number(match.endLine),
      preview: String(match.preview),
      ...(match.symbol !== undefined ? { symbol: String(match.symbol) } : {}),
    })),
    truncated: matches.length >= options.maxResults && docs.length > matches.length,
  };
}

export function parentDirectory(path: string): string {
  return dirname(path);
}
