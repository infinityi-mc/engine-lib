/**
 * The tool contract — a named capability the model can invoke.
 *
 * A {@link ToolDefinition} couples a Phase-1 parameter {@link Schema} (used to
 * advertise the tool to a provider and to validate model-supplied arguments at
 * the boundary in Phase 4) with a typed `execute` function. Execution returns a
 * structured {@link ToolResult}: a *successful* outcome carries content fed back
 * to the model, while a *failed* outcome is surfaced to the model as a tool
 * error rather than thrown — bad arguments and tool failures become data the
 * model can recover from, not unhandled exceptions. The stable application
 * path is {@link defineTool}; hand-written {@link ToolDefinition} objects are
 * mainly useful for adapters and tests.
 *
 * @module
 */

import type { EngineContext } from "../runtime/types";
import type { Schema } from "../schema/types";
import type { RunBridge } from "../execution/types";
import type { HumanInputGateway } from "../approval/types";
import type { PolicyAction, PolicyEngine } from "../governance/policy";

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
  /** Active human-input gateway, present when configured on the parent run. */
  readonly humanInput?: HumanInputGateway;
  /** Session tenant scope, when run is bound to one. */
  readonly tenantId?: string;
  /** Host principal id, when supplied. */
  readonly principal?: string;
  /** Optional policy engine for tool-pack side checks. */
  readonly policy?: PolicyEngine;
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
 * A failed tool outcome for expected/domain failures such as "file not found"
 * or "permission denied". Surfaced to the model as a tool error (an `isError`
 * tool-result message), never thrown out of the run loop.
 *
 * `error` is intentionally a string in the stable contract. If a tool needs to
 * return structured diagnostics, encode them in the string or return a
 * structured success payload with an application-level status.
 */
export interface ToolFailure {
  readonly ok: false;
  readonly error: string;
}

/** The structured result of a tool invocation, discriminated on `ok`. */
export type ToolResult = ToolSuccess | ToolFailure;

/** Governance metadata used when a run-level {@link PolicyEngine} evaluates a tool call. */
export interface ToolPolicyMetadata {
  /** Explicit operation category for policy checks. */
  readonly operation:
    | PolicyAction["operation"]
    | ((args: unknown) => PolicyAction["operation"]);
  /** Effective target for policy checks. Defaults to common argument fields or the tool name. */
  readonly target?: string | ((args: unknown) => string | undefined);
}

/** Typed authoring shape for {@link ToolPolicyMetadata}. */
export interface ToolPolicySpec<TArgs = unknown> {
  /** Explicit operation category for policy checks. */
  readonly operation:
    | PolicyAction["operation"]
    | ((args: TArgs) => PolicyAction["operation"]);
  /** Effective target for policy checks. Defaults to common argument fields or the tool name. */
  readonly target?: string | ((args: TArgs) => string | undefined);
}

/**
 * A named capability the model can invoke.
 *
 * `TArgs` is the validated argument type; with {@link defineTool} it is inferred
 * from `parameters` so `execute` receives fully-typed arguments.
 */
export interface ToolDefinition<TArgs = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly policy?: ToolPolicyMetadata;
  /** Parameter schema: `.jsonSchema` is advertised to the provider, `.parse` validates args. */
  readonly parameters: Schema<TArgs>;
  /**
   * Run the tool with already-validated arguments.
   *
   * Return `{ ok: true, content }` for success and `{ ok: false, error }` for
   * expected/domain failures. Throw only for unexpected implementation faults;
   * `runAgent` catches thrown errors and feeds them back to the model as
   * recoverable tool-result errors.
   */
  execute(args: TArgs, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}
