/**
 * Helpers that surface shell policy / approval / execution metadata onto the
 * run's event stream as generic `custom` {@link RunEvent}s.
 *
 * All events share the `"shell."` name prefix so subscribers can filter the
 * module's traffic. Emission goes through {@link ToolContext.run} (the
 * {@link RunBridge}) and is a no-op when the tool runs outside `runAgent`, so a
 * tool invoked directly in a test still works without a run.
 *
 * @module
 */

import type { ToolContext } from "../tools/types";
import type { CommandRequest, CommandResult } from "./types";

/** Event names emitted by this module, under the shared `shell.` namespace. */
export const SHELL_EVENT = {
  policy: "shell.policy",
  approval: "shell.approval",
  execStart: "shell.exec.start",
  execChunk: "shell.exec.chunk",
  execEnd: "shell.exec.end",
} as const;

/** Emit a `custom` event through the run bridge, if one is present. */
function emit(ctx: ToolContext, name: string, data: Record<string, unknown>): void {
  ctx.run?.emit({ type: "custom", name, data });
}

/** A policy decision (cwd allowlist or command allow/deny). */
export function emitPolicy(
  ctx: ToolContext,
  decision: "allow" | "deny",
  req: Pick<CommandRequest, "command" | "args" | "mode">,
  reason?: string,
): void {
  emit(ctx, SHELL_EVENT.policy, {
    decision,
    command: req.command,
    args: req.args,
    mode: req.mode,
    ...(reason !== undefined ? { reason } : {}),
  });
}

/** An approval lifecycle update. */
export function emitApproval(
  ctx: ToolContext,
  status: "requested" | "approved" | "denied",
  req: CommandRequest,
  reason?: string,
): void {
  emit(ctx, SHELL_EVENT.approval, {
    status,
    command: req.command,
    args: req.args,
    cwd: req.cwd,
    mode: req.mode,
    ...(reason !== undefined ? { reason } : {}),
  });
}

/** Execution is about to begin. */
export function emitExecStart(ctx: ToolContext, req: CommandRequest): void {
  emit(ctx, SHELL_EVENT.execStart, {
    command: req.command,
    args: req.args,
    cwd: req.cwd,
    mode: req.mode,
    timeoutMs: req.timeoutMs,
  });
}

/** A streamed output chunk (only `spawn_command` emits these). */
export function emitExecChunk(
  ctx: ToolContext,
  stream: "stdout" | "stderr",
  text: string,
): void {
  emit(ctx, SHELL_EVENT.execChunk, { stream, text });
}

/** Execution finished; carries the structured result summary. */
export function emitExecEnd(ctx: ToolContext, result: CommandResult): void {
  emit(ctx, SHELL_EVENT.execEnd, {
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  });
}

/**
 * Execution failed before producing a result (the process could not be
 * spawned). Emits a closing `shell.exec.end` so subscribers that pair
 * start/end events always see the span close, with `error` set and `exitCode`
 * null to mark that the command never ran.
 */
export function emitExecError(ctx: ToolContext, req: CommandRequest, error: string): void {
  emit(ctx, SHELL_EVENT.execEnd, {
    command: req.command,
    exitCode: null,
    signal: null,
    timedOut: false,
    error,
  });
}
