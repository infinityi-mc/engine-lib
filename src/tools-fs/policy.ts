import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { FilesystemPolicyError } from "../errors";
import type { FilesystemToolsConfig } from "./types";

export interface AllowedRoot {
  readonly logical: string;
  readonly real: string;
}

export interface FilesystemPolicy {
  readonly allowedRoots: readonly AllowedRoot[];
  readonly defaultRoot: string;
  readonly defaultRootReal: string;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxEntries: number;
  readonly maxResults: number;
}

export interface ResolvedPath {
  readonly path: string;
  readonly root: string;
  readonly realPath?: string;
}

export class FilesystemAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemAccessError";
  }
}

const DEFAULT_MAX_READ_BYTES = 20_000;
const DEFAULT_MAX_WRITE_BYTES = 1_000_000;
const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_RESULTS = 50;

export function normalizePathForOutput(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : normalizePathForOutput(rel);
}

function realpathIfPossible(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

function assertPositiveInt(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new FilesystemPolicyError(
      `filesystemTools: \`${name}\` must be a positive integer`,
    );
  }
  return value;
}

export function normalizeFilesystemPolicy(
  config: FilesystemToolsConfig,
): FilesystemPolicy {
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.length === 0) {
    throw new FilesystemPolicyError(
      "filesystemTools: `allowedRoots` must be a non-empty array of absolute paths",
    );
  }

  const allowedRoots = config.allowedRoots.map((entry) => {
    if (typeof entry !== "string" || !isAbsolute(entry)) {
      throw new FilesystemPolicyError(
        `filesystemTools: allowedRoots entry must be an absolute path, got ${JSON.stringify(entry)}`,
      );
    }
    const logical = resolve(entry);
    return { logical, real: realpathIfPossible(logical) };
  });

  const defaultRoot =
    config.defaultRoot === undefined
      ? allowedRoots[0]!.logical
      : resolve(allowedRoots[0]!.logical, config.defaultRoot);
  const defaultRootReal = realpathIfPossible(defaultRoot);
  const defaultAllowed = allowedRoots.some(
    (root) =>
      isInside(root.logical, defaultRoot) &&
      isInside(root.real, defaultRootReal),
  );
  if (!defaultAllowed) {
    throw new FilesystemPolicyError(
      "filesystemTools: `defaultRoot` must resolve inside allowedRoots",
    );
  }

  return {
    allowedRoots,
    defaultRoot,
    defaultRootReal,
    maxReadBytes: assertPositiveInt(
      "maxReadBytes",
      config.maxReadBytes,
      DEFAULT_MAX_READ_BYTES,
    ),
    maxWriteBytes: assertPositiveInt(
      "maxWriteBytes",
      config.maxWriteBytes,
      DEFAULT_MAX_WRITE_BYTES,
    ),
    maxEntries: assertPositiveInt(
      "maxEntries",
      config.maxEntries,
      DEFAULT_MAX_ENTRIES,
    ),
    maxResults: assertPositiveInt(
      "maxResults",
      config.maxResults,
      DEFAULT_MAX_RESULTS,
    ),
  };
}

function allowedRootFor(
  policy: FilesystemPolicy,
  logicalPath: string,
): AllowedRoot | null {
  return (
    policy.allowedRoots.find((root) => isInside(root.logical, logicalPath)) ??
    null
  );
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  const stat = lstatSync(current);
  return stat.isDirectory() ? current : dirname(current);
}

export async function resolvePath(
  policy: FilesystemPolicy,
  input: string | undefined,
  options: {
    readonly base?: string;
    readonly mustExist?: boolean;
    readonly forCreate?: boolean;
  } = {},
): Promise<ResolvedPath> {
  const raw = input === undefined || input === "" ? "." : input;
  const base = options.base ?? policy.defaultRoot;
  const logicalPath = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const root = allowedRootFor(policy, logicalPath);
  if (root === null) {
    throw new FilesystemAccessError(
      `path ${JSON.stringify(raw)} is outside the allowed roots`,
    );
  }

  if (options.mustExist === true && !existsSync(logicalPath)) {
    throw new FilesystemAccessError(
      `path ${JSON.stringify(raw)} does not exist`,
    );
  }

  if (existsSync(logicalPath)) {
    const realPath = realpathSync.native(logicalPath);
    if (!isInside(root.real, realPath)) {
      throw new FilesystemAccessError(
        `path ${JSON.stringify(raw)} resolves outside the allowed roots`,
      );
    }
    return { path: logicalPath, root: root.logical, realPath };
  }

  if (options.forCreate === true || options.mustExist !== true) {
    const parent = nearestExistingParent(logicalPath);
    const parentReal = realpathSync.native(parent);
    if (!isInside(root.real, parentReal)) {
      throw new FilesystemAccessError(
        `path ${JSON.stringify(raw)} parent resolves outside the allowed roots`,
      );
    }
    return { path: logicalPath, root: root.logical };
  }

  throw new FilesystemAccessError(`path ${JSON.stringify(raw)} does not exist`);
}

export async function resolveRoot(
  policy: FilesystemPolicy,
  input: string | undefined,
): Promise<ResolvedPath> {
  const resolved = await resolvePath(policy, input, { mustExist: true });
  if (!lstatSync(resolved.path).isDirectory()) {
    throw new FilesystemAccessError(
      `root ${JSON.stringify(input ?? ".")} is not a directory`,
    );
  }
  return resolved;
}
