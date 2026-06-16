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

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";

import { execCommand } from "../tools-shell/exec";
import type { SandboxOptions, SandboxResult, ToolSandbox } from "./types";

/** Options for {@link dockerSandbox}. */
export interface DockerSandboxHardeningOptions {
  readonly readOnlyRootfs?: boolean;
  readonly tmpfs?: boolean;
  readonly dropCapabilities?: boolean;
  readonly noNewPrivileges?: boolean;
  readonly seccompProfile?: string | false;
  readonly pidsLimit?: number | false;
  readonly user?: string | false;
}

export interface DockerRunArgsOptions {
  readonly extraArgs?: readonly string[];
  readonly envFile?: string;
  readonly containerName?: string;
  readonly hardening?: DockerSandboxHardeningOptions;
}

/** Options for {@link dockerSandbox}. */
export interface DockerSandboxOptions {
  /**
   * Container image to run the command in.
   *
   * Security-sensitive callers should pin this to an immutable digest, for
   * example `alpine@sha256:...`, rather than a mutable tag such as `alpine:3`.
   * The sandbox intentionally does not resolve or verify image tags itself.
   */
  readonly image: string;
  /** Container runtime CLI. Defaults to `"docker"`. */
  readonly runtime?: "docker" | "podman";
  /** Extra args inserted before the image (e.g. `--user`, `--read-only`). */
  readonly extraArgs?: readonly string[];
  /** Secure container defaults. Enabled by default. */
  readonly hardening?: DockerSandboxHardeningOptions;
}

function pathOf(
  path: string | { readonly path: string; readonly writable?: boolean },
): string {
  return typeof path === "string" ? path : path.path;
}

function normalizeHostPath(hostPath: string): string {
  if (hostPath.trim() === "") throw new Error("sandbox path must be non-empty");
  const normalized = resolve(hostPath);
  const parsed = parse(normalized);
  if (normalized === parsed.root) {
    throw new Error(`refusing to mount filesystem root: ${hostPath}`);
  }
  const lower = normalized.replace(/\\/g, "/").toLowerCase();
  const sensitiveRoots = ["/proc", "/sys", "/etc", "/var/run"];
  if (sensitiveRoots.some((root) => lower === root || lower.startsWith(`${root}/`))) {
    throw new Error(`refusing to mount sensitive host path: ${hostPath}`);
  }
  if (basename(lower) === "docker.sock" || lower.endsWith("/docker.sock")) {
    throw new Error(`refusing to mount Docker socket: ${hostPath}`);
  }
  return normalized;
}

function normalizeMount(
  path: string | { readonly path: string; readonly writable?: boolean },
): string | { readonly path: string; readonly writable?: boolean } {
  const normalized = normalizeHostPath(pathOf(path));
  return typeof path === "string" ? normalized : { ...path, path: normalized };
}

function containerPath(hostPath: string, index: number): string {
  return /^[A-Za-z]:[\\/]/.test(hostPath) || hostPath.includes("\\")
    ? `/workspace/mount-${index}`
    : hostPath;
}

function mountSpec(
  path: string | { readonly path: string; readonly writable?: boolean },
  index: number,
): string {
  const hostPath = pathOf(path);
  const mode = typeof path === "string" || path.writable !== true ? "ro" : "rw";
  return `${hostPath}:${containerPath(hostPath, index)}:${mode}`;
}

function defaultContainerUser(): string {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid =
    typeof process.getgid === "function" ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : "1000:1000";
}

function applyHardening(
  args: string[],
  hardening: DockerSandboxHardeningOptions | undefined,
): void {
  if (hardening?.readOnlyRootfs ?? true) args.push("--read-only");
  if (hardening?.tmpfs ?? true) args.push("--tmpfs", "/tmp:size=64m");
  if (hardening?.dropCapabilities ?? true) args.push("--cap-drop=ALL");
  if (hardening?.noNewPrivileges ?? true)
    args.push("--security-opt", "no-new-privileges:true");
  // Docker's runtime-default seccomp profile is enabled by omitting this flag;
  // values like "runtime/default" are Kubernetes syntax and fail on Docker CLI.
  const seccomp = hardening?.seccompProfile ?? false;
  if (seccomp !== false) args.push("--security-opt", `seccomp=${seccomp}`);
  const pidsLimit = hardening?.pidsLimit ?? 256;
  if (pidsLimit !== false) args.push("--pids-limit", String(pidsLimit));
  const user = hardening?.user ?? defaultContainerUser();
  if (user !== false) args.push("--user", user);
}

/** @internal */
export function buildRunArgs(
  image: string,
  command: string,
  commandArgs: readonly string[],
  options: SandboxOptions,
  runOptions: readonly string[] | DockerRunArgsOptions = [],
): string[] {
  let extraArgs: readonly string[];
  let envFile: string | undefined;
  let containerName: string | undefined;
  let hardening: DockerSandboxHardeningOptions | undefined;
  if (Array.isArray(runOptions)) {
    extraArgs = runOptions as readonly string[];
  } else {
    const opts = runOptions as DockerRunArgsOptions;
    extraArgs = opts.extraArgs ?? [];
    envFile = opts.envFile;
    containerName = opts.containerName;
    hardening = opts.hardening;
  }
  const args: string[] = ["run", "--rm", "-i"];
  if (containerName !== undefined) args.push("--name", containerName);
  if (!options.networkAccess) args.push("--network", "none");
  if (options.memoryLimitMb !== undefined)
    args.push("--memory", `${options.memoryLimitMb}m`);
  if (options.cpuLimit !== undefined)
    args.push("--cpus", String(options.cpuLimit));
  applyHardening(args, hardening);
  const filesystemPaths = options.filesystemPaths.map(normalizeMount);
  for (const [index, path] of filesystemPaths.entries()) {
    args.push("-v", mountSpec(path, index));
  }
  // Run inside the first mounted path when present, else the requested cwd.
  const workdir =
    filesystemPaths[0] !== undefined
      ? containerPath(pathOf(filesystemPaths[0]), 0)
      : containerPath(normalizeHostPath(options.cwd), 0);
  args.push("-w", workdir);
  if (envFile !== undefined) args.push("--env-file", envFile);
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
      const envDir = await mkdtemp(join(tmpdir(), "engine-sandbox-"));
      const envFile = join(envDir, "env");
      const containerName = `engine-sandbox-${randomUUID()}`;
      try {
        const envContent = Object.entries(sandboxOptions.env)
          .map(([key, value]) => {
            if (value.includes("\n")) {
              throw new Error(
                `Environment variable "${key}" contains a newline, which is not supported in --env-file format`,
              );
            }
            return `${key}=${value}`;
          })
          .join("\n");
        await writeFile(envFile, envContent, { encoding: "utf8", mode: 0o600 });
        const runArgs = buildRunArgs(
          options.image,
          command,
          commandArgs,
          sandboxOptions,
          { extraArgs, envFile, containerName, hardening: options.hardening },
        );
        const result = await execCommand({
          command: runtime,
          args: runArgs,
          cwd: sandboxOptions.cwd,
          env: {},
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
      } finally {
        try {
          await execCommand({
            command: runtime,
            args: ["rm", "-f", containerName],
            cwd: sandboxOptions.cwd,
            env: {},
            timeoutMs: 5_000,
            maxOutputBytes: 0,
          });
        } catch {
          // Best-effort sweep for containers left behind when the run CLI is killed.
        }
        await rm(envDir, { recursive: true, force: true });
      }
    },
  };
}
