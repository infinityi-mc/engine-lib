/**
 * `@infinityi/engine-lib/tools-sandbox` — an **optional** module providing an
 * isolation boundary for command execution.
 *
 * {@link ShellToolsConfig.sandbox} accepts any {@link ToolSandbox}; the shell
 * tool routes execution through it *after* its existing cwd/command/approval
 * gates pass. {@link localSandbox} (the default when none is configured) is a
 * thin pass-through to the in-process executor; {@link dockerSandbox} runs the
 * command in a container with network/filesystem/resource isolation.
 *
 * @example
 * ```ts
 * import { shellTools } from "@infinityi/engine-lib/tools-shell";
 * import { dockerSandbox } from "@infinityi/engine-lib/tools-sandbox";
 *
 * const { runCommand } = shellTools({
 *   allowedCwds: [process.cwd()],
 *   sandbox: dockerSandbox({ image: "alpine:3" }),
 * });
 * ```
 *
 * @module
 */

export { localSandbox } from "./local";
export type { LocalSandboxOptions } from "./local";
export { dockerSandbox } from "./docker";
export type { DockerSandboxOptions } from "./docker";

export type {
  SandboxChunk,
  SandboxOptions,
  SandboxResult,
  ToolSandbox,
} from "./types";
