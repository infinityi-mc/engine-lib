/**
 * The tool contract — a named capability the model can invoke.
 *
 * A {@link ToolDefinition} couples a Phase-1 parameter {@link Schema} (used to
 * advertise the tool to a provider and to validate model-supplied arguments at
 * the boundary in Phase 4) with a typed `execute` function. Execution returns a
 * structured {@link ToolResult}: a *successful* outcome carries content fed back
 * to the model, while a *failed* outcome is surfaced to the model as a tool
 * error rather than thrown — bad arguments and tool failures become data the
 * model can recover from, not unhandled exceptions.
 *
 * @module
 */

import type { EngineContext } from "../runtime/types";
import type { Schema } from "../schema/types";
import type { RunBridge } from "../execution/types";

/**
 * Per-invocation context handed to a tool's {@link ToolDefinition.execute}.
 *
 * Extends the shared {@link EngineContext} (telemetry / logger / cancellation
 * signal) with call-correlation metadata. Only the owning agent's *name* is
 * exposed — not the agent itself — so tools never carry a forward dependency on
 * the agent module.
 */
export interface ToolContext extends EngineContext {
  /** Correlates this invocation to the model's `ToolCall.id`. */
  readonly toolCallId: string;
  /** Name of the agent that owns this tool, when run inside one. */
  readonly agentName?: string;
  /**
   * Bridge to the surrounding run, present when the tool is dispatched by the
   * Phase-4 loop. Lets a tool forward nested events and report token usage to
   * the parent run (used by sub-agent-as-tool); absent when a tool is invoked
   * outside `runAgent`.
   */
  readonly run?: RunBridge;
}

/**
 * A successful tool outcome.
 *
 * `content` is rendered to text for the model: strings pass through unchanged;
 * any other value is JSON-encoded (see `renderToolContent`).
 */
export interface ToolSuccess {
  readonly ok: true;
  readonly content: unknown;
}

/**
 * A failed tool outcome. Surfaced to the model as a tool error (an `isError`
 * tool-result message), never thrown out of the run loop.
 */
export interface ToolFailure {
  readonly ok: false;
  readonly error: string;
}

/** The structured result of a tool invocation, discriminated on `ok`. */
export type ToolResult = ToolSuccess | ToolFailure;

/**
 * A named capability the model can invoke.
 *
 * `TArgs` is the validated argument type; with {@link defineTool} it is inferred
 * from `parameters` so `execute` receives fully-typed arguments.
 */
export interface ToolDefinition<TArgs = unknown> {
  readonly name: string;
  readonly description?: string;
  /** Parameter schema: `.jsonSchema` is advertised to the provider, `.parse` validates args. */
  readonly parameters: Schema<TArgs>;
  /** Run the tool. Return a {@link ToolResult}; throwing is reserved for unexpected faults. */
  execute(args: TArgs, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}
