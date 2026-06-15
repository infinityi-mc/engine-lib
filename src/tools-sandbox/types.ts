/**
 * Public contracts for the optional `@infinityi/engine-lib/tools-sandbox`
 * module — an isolation boundary for command execution.
 *
 * A {@link ToolSandbox} runs a command with bounded blast radius (network,
 * filesystem, memory/CPU limits). The shell tool delegates to it *after* its
 * existing cwd/command/approval gates pass, so the sandbox composes with — it
 * does not replace — the per-pack policy. The default {@link localSandbox} is a
 * thin pass-through to the in-process executor, preserving today's behaviour.
 *
 * @module
 */

import type { CommandResult } from "../tools-shell/types";

/** A streamed output chunk delivered to {@link SandboxOptions.onChunk}. */
export interface SandboxChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

/** Per-execution isolation parameters derived from shell config + the request. */
export interface SandboxOptions {
  /** Working directory the command runs in (already resolved to absolute). */
  readonly cwd: string;
  /** Effective environment for the command. */
  readonly env: Record<string, string>;
  /** Kill the command after this many milliseconds. */
  readonly timeoutMs: number;
  /** Whether the command may reach the network. */
  readonly networkAccess: boolean;
  /** Filesystem paths the command may access (mount surface for container sandboxes). */
  readonly filesystemPaths: readonly string[];
  /** Optional memory ceiling in megabytes. */
  readonly memoryLimitMb?: number;
  /** Optional CPU limit (cores). */
  readonly cpuLimit?: number;
  /** Byte cap per stream (stdout / stderr) before truncation. */
  readonly maxOutputBytes: number;
  /** Called for each output chunk as it streams in (used by `spawn_command`). */
  readonly onChunk?: (chunk: SandboxChunk) => void;
  /** Caller cancellation; terminates the sandboxed execution when aborted. */
  readonly signal?: AbortSignal;
}

/** Shape-compatible with {@link CommandResult} so the shell mapping is unchanged. */
export type SandboxResult = CommandResult;

/** An isolation boundary for command execution. */
export interface ToolSandbox {
  execute(
    command: string,
    args: readonly string[],
    options: SandboxOptions,
  ): Promise<SandboxResult>;
}
