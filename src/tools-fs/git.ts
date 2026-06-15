import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(
  root: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

function truncate(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 13))}\n[truncated]`,
    truncated: true,
  };
}

function splitGitDiffByFile(diff: string): Map<string, string> {
  const sections = diff.match(/^diff --git .*?(?=^diff --git |\s*$)/gms) ?? [];
  const byPath = new Map<string, string>();
  for (const section of sections) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    if (header === null) continue;
    const oldPath = header[1]?.replaceAll("\\", "/");
    const newPath = header[2]?.replaceAll("\\", "/");
    if (oldPath !== undefined) byPath.set(oldPath, section);
    if (newPath !== undefined) byPath.set(newPath, section);
  }
  return byPath;
}

export async function diffStatus(
  root: string,
  options: {
    readonly paths?: readonly string[];
    readonly includeDiff: boolean;
    readonly maxDiffChars: number;
    readonly contextLines: number;
  },
): Promise<{
  readonly isGitRepo: boolean;
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly diff?: string;
  }[];
  readonly truncated: boolean;
}> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { isGitRepo: false, files: [], truncated: false };

  // N19: canonicalize root for containment check against git-reported paths.
  const resolvedRoot = resolve(root.trim());

  const pathArgs =
    options.paths !== undefined && options.paths.length > 0
      ? ["--", ...options.paths]
      : [];
  const status = await git(root, ["status", "--porcelain=v1", ...pathArgs]);
  if (status === null) return { isGitRepo: false, files: [], truncated: false };
  const topTrimmed = top.trim();
  const files = status
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const statusCode = line.slice(0, 2).trim() || "modified";
      const path = line
        .slice(3)
        .replace(/^.* -> /, "")
        .replaceAll("\\", "/");
      return { path, status: statusCode };
    })
    // N19: filter paths that resolve outside the requested root directory.
    .filter((file) => {
      if (options.paths !== undefined && options.paths.length > 0) return true;
      const abs = resolve(topTrimmed, file.path);
      const rel = relative(resolvedRoot, abs);
      // A path is inside root iff `relative` doesn't start with `..` and isn't
      // an absolute path (which indicates a different drive on Windows).
      return !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\") && rel !== "";
    });

  if (!options.includeDiff || files.length === 0) {
    return { isGitRepo: true, files, truncated: false };
  }

  const diff = await git(root, [
    "diff",
    `--unified=${options.contextLines}`,
    ...pathArgs,
  ]);
  const diffByFile = splitGitDiffByFile(diff ?? "");
  let truncated = false;
  const withDiff = files.map((file) => {
    const clipped = truncate(
      diffByFile.get(file.path) ?? "",
      options.maxDiffChars,
    );
    truncated = truncated || clipped.truncated;
    return { ...file, diff: clipped.text };
  });
  return {
    isGitRepo: true,
    files: withDiff,
    truncated,
  };
}
