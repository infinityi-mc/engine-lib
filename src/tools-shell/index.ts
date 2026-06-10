/**
 * `@infinityi/engine-lib/tools-shell` — an **optional** module providing safe,
 * policy-gated command execution as ready-made tools.
 *
 * The core library ships no code-execution tools by design. This subpath is the
 * opt-in exception for hosts that need it (coding terminals, ops agents): a
 * single {@link shellTools} factory yields `run_command` (buffered) and
 * `spawn_command` (streamed) tools wrapped in working-directory allowlists,
 * environment filtering, command allow/deny policy, and optional approval
 * hooks. Every decision is surfaced as a `custom` run event for auditing.
 *
 * @example
 * ```ts
 * import { shellTools } from "@infinityi/engine-lib/tools-shell";
 * import { defineAgent } from "@infinityi/engine-lib/agent";
 *
 * const { runCommand } = shellTools({
 *   allowedCwds: [process.cwd()],
 *   policy: { deny: [/\brm\b/, /\bsudo\b/] },
 *   env: { allow: ["PATH", "HOME"] },
 * });
 *
 * const agent = defineAgent({ name: "ops", tools: [runCommand], ... });
 * ```
 *
 * @module
 */

export { shellTools } from "./define";
export { SHELL_EVENT } from "./events";

export type {
  ApprovalDecision,
  CommandPattern,
  CommandRequest,
  CommandResult,
  EnvPolicy,
  ShellPolicy,
  ShellTools,
  ShellToolsConfig,
} from "./types";
