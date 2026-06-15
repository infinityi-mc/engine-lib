/**
 * {@link dockerSandbox} — a container-isolated {@link ToolSandbox}.
 *
 * Runs the command inside a container via the `docker`/`podman` CLI with the
 * requested isolation: `--network none` when network access is denied,
 * read-write bind mounts for `filesystemPaths`, `--memory` for the memory limit,
 * `--cpus` for the CPU limit, and the same timeout/abort-kill semantics as the
 * in-process executor (we kill the CLI process, which tears down the container
 * via `--rm`).
 *
 * The container CLI itself is spawned through the shared `execCommand`
 * primitive, so streaming, byte caps, timeout, and abort-kill behave identically
 * to the local sandbox. Output/exit are mapped back into a {@link SandboxResult}
 * keyed to the *inner* command for shape-compatibility.
 *
 * @module
 */

import { execCommand } from "../tools-shell/exec";
import type { SandboxOptions, SandboxResult, ToolSandbox } from "./types";

/** Options for {@link dockerSandbox}. */
export interface DockerSandboxOptions {
  /** Container image to run the command in. */
  readonly image: string;
  /** Container runtime CLI. Defaults to `"docker"`. */
  readonly runtime?: "docker" | "podman";
  /** Extra args inserted before the image (e.g. `--user`, `--read-only`). */
  readonly extraArgs?: readonly string[];
}

/** @internal */
export function buildRunArgs(
  image: string,
  command: string,
  commandArgs: readonly string[],
  options: SandboxOptions,
  extraArgs: readonly string[],
): string[] {
  const args: string[] = ["run", "--rm", "-i"];
  if (!options.networkAccess) args.push("--network", "none");
  if (options.memoryLimitMb !== undefined)
    args.push("--memory", `${options.memoryLimitMb}m`);
  if (options.cpuLimit !== undefined)
    args.push("--cpus", String(options.cpuLimit));
  for (const path of options.filesystemPaths)
    args.push("-v", `${path}:${path}`);
  // Run inside the first mounted path when present, else the requested cwd.
  const workdir = options.filesystemPaths[0] ?? options.cwd;
  args.push("-w", workdir);
  for (const [key, value] of Object.entries(options.env))
    args.push("-e", `${key}=${value}`);
  args.push(...extraArgs);
  args.push(image, command, ...commandArgs);
  return args;
}

/**
 * A container-isolated sandbox. Requires a working `docker`/`podman` CLI on the
 * host; spawn failures surface like any other command failure (exitCode null).
 */
export function dockerSandbox(options: DockerSandboxOptions): ToolSandbox {
  const runtime = options.runtime ?? "docker";
  const extraArgs = options.extraArgs ?? [];
  return {
    async execute(
      command: string,
      commandArgs: readonly string[],
      sandboxOptions: SandboxOptions,
    ): Promise<SandboxResult> {
      const runArgs = buildRunArgs(
        options.image,
        command,
        commandArgs,
        sandboxOptions,
        extraArgs,
      );
      const result = await execCommand({
        command: runtime,
        args: runArgs,
        cwd: sandboxOptions.cwd,
        env: sandboxOptions.env,
        timeoutMs: sandboxOptions.timeoutMs,
        maxOutputBytes: sandboxOptions.maxOutputBytes,
        ...(sandboxOptions.onChunk !== undefined
          ? { onChunk: sandboxOptions.onChunk }
          : {}),
        ...(sandboxOptions.signal !== undefined
          ? { signal: sandboxOptions.signal }
          : {}),
      });
      // Re-key the result to the inner command so the shell tool's mapping and
      // events describe what the model ran, not the container invocation.
      return {
        ...result,
        command,
        args: commandArgs,
        cwd: sandboxOptions.cwd,
      };
    },
  };
}
