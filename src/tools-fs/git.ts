import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<string | null> {
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

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 13))}\n[truncated]`, truncated: true };
}

export async function diffStatus(root: string, options: {
  readonly paths?: readonly string[];
  readonly includeDiff: boolean;
  readonly maxDiffChars: number;
  readonly contextLines: number;
}): Promise<{
  readonly isGitRepo: boolean;
  readonly files: readonly { readonly path: string; readonly status: string; readonly diff?: string }[];
  readonly truncated: boolean;
}> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { isGitRepo: false, files: [], truncated: false };

  const pathArgs = options.paths !== undefined && options.paths.length > 0 ? ["--", ...options.paths] : [];
  const status = await git(root, ["status", "--porcelain=v1", ...pathArgs]);
  if (status === null) return { isGitRepo: false, files: [], truncated: false };
  const files = status
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const statusCode = line.slice(0, 2).trim() || "modified";
      const path = line.slice(3).replace(/^.* -> /, "").replaceAll("\\", "/");
      return { path, status: statusCode };
    });

  if (!options.includeDiff || files.length === 0) {
    return { isGitRepo: true, files, truncated: false };
  }

  const diff = await git(root, ["diff", `--unified=${options.contextLines}`, ...pathArgs]);
  const clipped = truncate(diff ?? "", options.maxDiffChars);
  return {
    isGitRepo: true,
    files: files.map((file) => ({ ...file, diff: clipped.text })),
    truncated: clipped.truncated,
  };
}
