/**
 * `shellTools` — the optional, policy-gated command-execution tool factory.
 *
 * Returns two {@link ToolDefinition}s, `run_command` (buffered) and
 * `spawn_command` (streamed), that share one execution pipeline:
 *
 *   validate cwd → classify command → (approval) → filter env → spawn → result
 *
 * Each gate emits a `custom` {@link RunEvent} so the host's existing
 * subscribers/auditing see every policy decision, approval, and execution. A
 * command never runs silently: a denied cwd, a denied command, or a withheld
 * approval all return `{ ok: false, error }` *before* any process is created.
 *
 * @module
 */

import { defineTool } from "../tools/define";
import type { ToolContext, ToolResult } from "../tools/types";
import { s } from "../schema/builder";
import type { PolicyDecision } from "../governance/policy";

import {
  emitApproval,
  emitExecChunk,
  emitExecEnd,
  emitExecError,
  emitExecStart,
  emitPolicy,
} from "./events";
import { execCommand } from "./exec";
import {
  classifyCommand,
  filterEnv,
  normalizeAllowedCwds,
  resolveCwd,
} from "./policy";
import type {
  ApprovalDecision,
  CommandRequest,
  ShellToolsConfig,
  ShellTools,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/** Model-facing parameters, identical for both tools. */
const PARAMS = s.object({
  command: s.string({
    description: "Program to run (argv[0]). Not interpreted by a shell.",
  }),
  args: s.optional(
    s.array(s.string(), { description: "Arguments passed to the program." }),
  ),
  cwd: s.optional(
    s.string({
      description: "Working directory. Must resolve within an allowed root.",
    }),
  ),
  timeoutMs: s.optional(
    s.number({
      int: true,
      description: "Kill the command after this many milliseconds.",
    }),
  ),
});

type ShellArgs = {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

/** Normalize the host's `approve` return into an {@link ApprovalDecision}. */
function toDecision(value: boolean | ApprovalDecision): ApprovalDecision {
  return typeof value === "boolean" ? { approved: value } : value;
}

function policyVerdict(decision: PolicyDecision): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  return decision.allowed
    ? { ok: true }
    : { ok: false, reason: decision.reason };
}

/**
 * Build a `run_command` / `spawn_command` pair bound to `config`.
 *
 * @throws {@link ShellPolicyError} if `allowedCwds` is empty or contains a
 * non-absolute path (a host-side configuration fault, raised eagerly here).
 */
export function shellTools(config: ShellToolsConfig): ShellTools {
  const allowedRoots = normalizeAllowedCwds(config.allowedCwds);
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const build = (mode: "run" | "spawn") => {
    const name = mode === "run" ? "run_command" : "spawn_command";
    const description =
      mode === "run"
        ? "Run a command to completion and return its captured stdout, stderr, and exit code."
        : "Run a command to completion, streaming its output, and return its exit code.";

    return defineTool({
      name,
      description,
      policy: { operation: "exec", target: (args) => args.command },
      parameters: PARAMS,
      async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
        const args = rawArgs as ShellArgs;
        const cmdArgs = args.args ?? [];

        // Gate 1: working-directory allowlist.
        const cwd = resolveCwd(args.cwd, allowedRoots);
        if (cwd === null) {
          const reason = `cwd ${JSON.stringify(args.cwd ?? ".")} is outside the allowed roots`;
          emitPolicy(
            ctx,
            "deny",
            { command: args.command, args: cmdArgs, mode },
            reason,
          );
          return { ok: false, error: reason };
        }

        // Gate 2: command allow/deny policy.
        const verdict = classifyCommand(args.command, cmdArgs, config.policy);
        if (!verdict.allowed) {
          emitPolicy(
            ctx,
            "deny",
            { command: args.command, args: cmdArgs, mode },
            verdict.reason,
          );
          return {
            ok: false,
            error: verdict.reason ?? "command denied by policy",
          };
        }
        emitPolicy(ctx, "allow", {
          command: args.command,
          args: cmdArgs,
          mode,
        });

        const timeoutMs = Math.min(
          args.timeoutMs !== undefined && args.timeoutMs > 0
            ? args.timeoutMs
            : defaultTimeout,
          maxTimeout,
        );
        const req: CommandRequest = {
          command: args.command,
          args: cmdArgs,
          cwd,
          timeoutMs,
          mode,
        };

        if (config.enginePolicy !== undefined) {
          const decision = await config.enginePolicy.evaluate(
            {
              tool: name,
              operation: "exec",
              target: args.command,
              arguments: req,
            },
            {
              agentName: ctx.agentName ?? "unknown",
              ...(ctx.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
              ...(ctx.principal !== undefined
                ? { principal: ctx.principal }
                : {}),
              messages: [],
            },
          );
          const verdict = policyVerdict(decision);
          if (!verdict.ok) {
            emitPolicy(
              ctx,
              "deny",
              { command: args.command, args: cmdArgs, mode },
              verdict.reason,
            );
            return {
              ok: false,
              error: verdict.reason ?? "command denied by policy",
            };
          }
        }

        // Gate 3: approval for destructive commands.
        if (config.requiresApproval?.(req) === true) {
          emitApproval(ctx, "requested", req);
          const decision = toDecision(
            config.approve === undefined ? false : await config.approve(req),
          );
          if (!decision.approved) {
            emitApproval(ctx, "denied", req, decision.reason);
            return {
              ok: false,
              error:
                decision.reason ?? `command "${args.command}" was not approved`,
            };
          }
          emitApproval(ctx, "approved", req, decision.reason);
        }

        // Execute.
        const env = filterEnv(process.env, config.env);
        emitExecStart(ctx, req);
        let result;
        try {
          if (config.sandbox !== undefined) {
            const sandboxFilesystemPaths = [
              req.cwd,
              ...(config.filesystemPaths ?? allowedRoots).filter(
                (path) => path !== req.cwd,
              ),
            ];
            result = await config.sandbox.execute(req.command, req.args, {
              cwd: req.cwd,
              env,
              timeoutMs,
              networkAccess: config.networkAccess ?? true,
              filesystemPaths: sandboxFilesystemPaths,
              maxOutputBytes,
              ...(config.memoryLimitMb !== undefined
                ? { memoryLimitMb: config.memoryLimitMb }
                : {}),
              ...(config.cpuLimit !== undefined
                ? { cpuLimit: config.cpuLimit }
                : {}),
              ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              ...(mode === "spawn"
                ? { onChunk: (c) => emitExecChunk(ctx, c.stream, c.text) }
                : {}),
            });
          } else {
            result = await execCommand({
              command: req.command,
              args: req.args,
              cwd: req.cwd,
              env,
              timeoutMs,
              maxOutputBytes,
              ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              ...(mode === "spawn"
                ? { onChunk: (c) => emitExecChunk(ctx, c.stream, c.text) }
                : {}),
            });
          }
        } catch (err) {
          // The process could not be spawned at all (e.g. unknown program).
          const message = err instanceof Error ? err.message : String(err);
          const error = `failed to run "${req.command}": ${message}`;
          // Close the lifecycle so start/end-pairing subscribers don't leak.
          emitExecError(ctx, req, error);
          return { ok: false, error };
        }
        emitExecEnd(ctx, result);
        return { ok: true, content: result };
      },
    });
  };

  return { runCommand: build("run"), spawnCommand: build("spawn") };
}
