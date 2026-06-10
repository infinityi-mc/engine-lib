import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { glob } from "glob";
import ignore from "ignore";

import { displayPath, normalizePathForOutput } from "./policy";

export interface ListedEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
}

export interface ListOptions {
  readonly includeHidden?: boolean;
  readonly respectGitignore?: boolean;
  readonly includeFiles?: boolean;
  readonly maxEntries?: number;
  readonly onlyFiles?: boolean;
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
}

const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  "*.tsbuildinfo",
];

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function fileVersion(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function languageForPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".ts":
      return "TypeScript";
    case ".tsx":
      return "TSX";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "JavaScript";
    case ".jsx":
      return "JSX";
    case ".json":
      return "JSON";
    case ".md":
      return "Markdown";
    case ".css":
      return "CSS";
    case ".html":
      return "HTML";
    case ".py":
      return "Python";
    case ".rs":
      return "Rust";
    case ".go":
      return "Go";
    case ".java":
      return "Java";
    case ".sh":
      return "Shell";
    case ".yml":
    case ".yaml":
      return "YAML";
    default:
      return undefined;
  }
}

export function isProbablyTextPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || basename(path).startsWith(".");
}

export function isHiddenRelativePath(path: string): boolean {
  return normalizePathForOutput(path)
    .split("/")
    .some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

async function buildIgnore(root: string, respectGitignore: boolean): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(DEFAULT_IGNORE);
  if (!respectGitignore) return ig;
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf8");
    ig.add(content);
  }
  return ig;
}

function hasGlobMatch(path: string, globs: readonly string[] | undefined): boolean {
  if (globs === undefined || globs.length === 0) return true;
  const matcher = ignore().add(globs.map((g) => g.replaceAll("\\", "/")));
  return matcher.ignores(path);
}

function isExcluded(path: string, globs: readonly string[] | undefined): boolean {
  if (globs === undefined || globs.length === 0) return false;
  const matcher = ignore().add(globs.map((g) => g.replaceAll("\\", "/")));
  return matcher.ignores(path);
}

export async function listEntries(root: string, options: ListOptions = {}): Promise<{
  readonly entries: ListedEntry[];
  readonly truncated: boolean;
  readonly total: number;
}> {
  const includeHidden = options.includeHidden ?? false;
  const respectGitignore = options.respectGitignore ?? true;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const ig = await buildIgnore(root, respectGitignore);
  const patterns = options.includeGlobs !== undefined && options.includeGlobs.length > 0
    ? [...options.includeGlobs]
    : ["**/*"];
  const matches = await glob(patterns, {
    cwd: root,
    dot: includeHidden,
    nodir: false,
    absolute: true,
    follow: false,
    windowsPathsNoEscape: true,
  });
  const entries: ListedEntry[] = [];
  let total = 0;

  for (const abs of matches.sort()) {
    const rel = normalizePathForOutput(relative(root, abs));
    if (rel === "") continue;
    if (!includeHidden && isHiddenRelativePath(rel)) continue;
    if (ig.ignores(rel)) continue;
    if (!hasGlobMatch(rel, options.includeGlobs)) continue;
    if (isExcluded(rel, options.excludeGlobs)) continue;

    const info = await lstat(abs);
    const type = info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other";
    if (options.onlyFiles === true && type !== "file") continue;
    if (options.includeFiles === false && type === "file") continue;

    total += 1;
    if (entries.length >= maxEntries) continue;
    entries.push({ path: abs, relativePath: rel, type, size: info.size });
  }

  return { entries, truncated: total > entries.length, total };
}

export async function readTextFile(path: string, maxBytes: number): Promise<{
  readonly text: string;
  readonly version: string;
  readonly truncated: boolean;
}> {
  const bytes = await readFile(path);
  const sliced = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  return {
    text: sliced.toString("utf8"),
    version: fileVersion(bytes),
    truncated: bytes.byteLength > maxBytes,
  };
}

export async function atomicWrite(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.engine-lib-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return fileVersion(content);
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function lineOffsets(text: string): readonly string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function renderLineRange(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  includeLineNumbers: boolean,
): string {
  const selected = lines.slice(startLine - 1, endLine);
  if (!includeLineNumbers) return selected.join("\n");
  return selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
}

export function clampLineRange(totalLines: number, startLine?: number, endLine?: number): {
  readonly startLine: number;
  readonly endLine: number;
} {
  const start = Math.max(1, Math.min(startLine ?? 1, Math.max(totalLines, 1)));
  const end = Math.max(start, Math.min(endLine ?? totalLines, Math.max(totalLines, 1)));
  return { startLine: start, endLine: end };
}

export function detectFrameworks(entries: readonly ListedEntry[]): string[] {
  const files = new Set(entries.map((entry) => entry.relativePath));
  const frameworks = new Set<string>();
  if (files.has("package.json")) frameworks.add("Node.js");
  if (files.has("bun.lock") || files.has("bun.lockb")) frameworks.add("Bun");
  if ([...files].some((file) => file.includes("vite.config."))) frameworks.add("Vite");
  if ([...files].some((file) => file.includes("next.config."))) frameworks.add("Next.js");
  if ([...files].some((file) => file.includes("tsconfig.json"))) frameworks.add("TypeScript");
  if (files.has("Cargo.toml")) frameworks.add("Rust/Cargo");
  if (files.has("go.mod")) frameworks.add("Go modules");
  return [...frameworks].sort();
}

export function importantFiles(entries: readonly ListedEntry[]): string[] {
  const importantNames = new Set([
    "README.md",
    "package.json",
    "tsconfig.json",
    "bun.lock",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "Dockerfile",
    ".gitignore",
  ]);
  return entries
    .filter((entry) => entry.type === "file" && importantNames.has(entry.relativePath))
    .map((entry) => entry.relativePath);
}

export function pathForDisplay(root: string, path: string): string {
  return displayPath(root, path);
}
