/**
 * Public types for the optional `@infinityi/engine-lib/tools-shell` module.
 *
 * This module is **not** part of the core library surface and is never imported
 * by `runAgent`. It is an opt-in tool factory for hosts (coding terminals, ops
 * agents) that need controlled command execution. Configuration lives entirely
 * host-side — the model only ever supplies a {@link CommandRequest}, never the
 * cwd allowlist, env filter, or policy.
 *
 * @module
 */

import type { ApprovalDecision as CoreApprovalDecision } from "../approval/types";
import type { PolicyEngine } from "../governance/policy";
import type { ToolSandbox } from "../tools-sandbox/types";

export type ApprovalDecision = CoreApprovalDecision;

/**
 * A command the model asked to run, after schema validation but before any
 * policy/approval gating. Passed to {@link ShellToolsConfig.requiresApproval}
 * and {@link ShellToolsConfig.approve}, and echoed in policy/approval events.
 */
export interface CommandRequest {
  /** Program to execute (argv[0]). */
  readonly command: string;
  /** Arguments passed to the program. */
  readonly args: readonly string[];
  /** Working directory the command will run in (already resolved to absolute). */
  readonly cwd: string;
  /** Effective timeout in milliseconds. */
  readonly timeoutMs: number;
  /** `"run_command"` (buffered) or `"spawn_command"` (streamed). */
  readonly mode: "run" | "spawn";
}

/** The structured outcome of a command, returned as the tool's `content`. */
export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Effective timeout in milliseconds for this execution. */
  readonly timeoutMs: number;
  /** Whether execution was delegated to a configured sandbox boundary. */
  readonly sandboxed: boolean;
  /** Native shell policy decision that allowed this execution to start. */
  readonly policyDecision: "allow";
  /** Process exit code, or `null` when killed by a signal (e.g. timeout). */
  readonly exitCode: number | null;
  /** Signal that killed the process, or `null`. */
  readonly signal: string | null;
  /** `true` when the process was killed because it exceeded its timeout. */
  readonly timedOut: boolean;
  /** `true` when the process was killed by the caller's cancellation signal. */
  readonly aborted: boolean;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Captured stdout (truncated to {@link ShellToolsConfig.maxOutputBytes}). */
  readonly stdout: string;
  /** Captured stderr (truncated to {@link ShellToolsConfig.maxOutputBytes}). */
  readonly stderr: string;
  /** `true` when stdout was truncated at the byte cap. */
  readonly stdoutTruncated: boolean;
  /** `true` when stderr was truncated at the byte cap. */
  readonly stderrTruncated: boolean;
}

/** A pattern matched against a command — exact string (against argv[0]) or regex (against the full command line). */
export type CommandPattern = string | RegExp;

/** Allow/deny rules for which commands may run. Deny always wins. */
export interface ShellPolicy {
  /**
   * Program-name rules matched against argv[0] only. Prefer this for simple
   * command allowlists such as `git`; `allow` regexes inspect the full argv
   * string and do not make arguments like `git -c ...` safe by themselves.
   */
  readonly argv0?: readonly CommandPattern[];
  /**
   * If present, a command must match at least one entry to be permitted.
   * Omitted → all commands are permitted unless denied.
   * String entries match argv[0] exactly; regex entries match the joined
   * command line including arguments.
   */
  readonly allow?: readonly CommandPattern[];
  /** A command matching any entry is rejected, even if also allowed. */
  readonly deny?: readonly CommandPattern[];
}

/** Inherited-environment filtering for spawned commands. */
export interface EnvPolicy {
  /**
   * Names of process env vars to pass through. Omitted → **no** inherited vars
   * are passed (safest default); only {@link EnvPolicy.extra} is provided.
   */
  readonly allow?: readonly string[];
  /** Names always stripped, even if listed in {@link EnvPolicy.allow}. */
  readonly deny?: readonly string[];
  /** Extra vars merged on top of the (filtered) inherited set. */
  readonly extra?: Readonly<Record<string, string>>;
}

/** Host-side configuration for {@link shellTools}. Never exposed to the model. */
export interface ShellToolsConfig {
  /**
   * Absolute directory roots a command may run under. A request's `cwd` must
   * resolve to one of these or a descendant. Required and non-empty — there is
   * no implicit default, so a command can never run somewhere unintended.
   *
   * Containment is a logical-path check that does not resolve symlinks; in
   * security-sensitive contexts pre-resolve these with `fs.realpathSync` and
   * keep outward-pointing symlinks out of the roots.
   */
  readonly allowedCwds: readonly string[];
  /** Inherited-env filtering. Defaults to "no inherited vars". */
  readonly env?: EnvPolicy;
  /** Command allow/deny rules. Omitted → all commands allowed. */
  readonly policy?: ShellPolicy;
  /** Optional unified policy engine evaluated after native shell gates. */
  readonly enginePolicy?: PolicyEngine;
  /**
   * Flag a command as destructive / requiring approval before it runs. When it
   * returns `true`, {@link ShellToolsConfig.approve} is consulted; if `approve`
   * is absent or denies, the command never executes.
   */
  readonly requiresApproval?: (req: CommandRequest) => boolean;
  /**
   * Approval hook invoked only when {@link ShellToolsConfig.requiresApproval}
   * returns `true`. Return `true`/`false` or an {@link ApprovalDecision}.
   */
  readonly approve?: (
    req: CommandRequest,
  ) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
  /** Timeout applied when the model omits `timeoutMs`. Defaults to 30_000. */
  readonly defaultTimeoutMs?: number;
  /** Upper bound clamping any model-supplied `timeoutMs`. Defaults to 600_000. */
  readonly maxTimeoutMs?: number;
  /** Byte cap per stream (stdout / stderr) before truncation. Defaults to 100_000. */
  readonly maxOutputBytes?: number;
  /**
   * Optional execution sandbox. When present, a command runs through
   * `sandbox.execute` (after all native gates pass) instead of the in-process
   * executor. Absent → in-process execution, byte-identical to today.
   */
  readonly sandbox?: ToolSandbox;
  /**
   * Whether the model may reach the network. Enforced only by a configured
   * sandbox. Defaults to true.
   */
  readonly networkAccess?: boolean;
  /** Filesystem paths the sandbox may mount. Defaults to the allowed cwds. */
  readonly filesystemPaths?: readonly string[];
  /** Optional memory ceiling (MB) passed to the sandbox. */
  readonly memoryLimitMb?: number;
  /** Optional CPU limit (cores) passed to the sandbox. */
  readonly cpuLimit?: number;
}

/** The pair of tool definitions returned by {@link shellTools}. */
export interface ShellTools {
  /** Buffered execution — awaits completion, returns captured output. */
  readonly runCommand: import("../tools/types").ToolDefinition;
  /** Streamed execution — emits output incrementally onto the run event stream. */
  readonly spawnCommand: import("../tools/types").ToolDefinition;
}
