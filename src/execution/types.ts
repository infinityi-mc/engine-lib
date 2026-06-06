/**
 * Types for the agent execution flow.
 *
 * {@link runAgent} drives the provider-native tool-calling loop. It runs in two
 * shapes that share one core: *buffered* (returns a {@link RunResult}) and
 * *streaming* (returns a {@link RunHandle} — an async-iterable of
 * {@link RunEvent}s plus a `completed` promise). Both modes also feed
 * {@link RunOptions.onEvent}.
 *
 * The {@link RunEvent} union is introduced here because streaming needs it;
 * Phase 6 formalizes a multi-subscriber emitter and telemetry spans on top.
 *
 * @module
 */

import type { AgentError } from "../errors";
import type { Message } from "../messages/types";
import type { FinishReason, Usage } from "../providers/types";
import type { Logger, TelemetryHandle } from "../runtime/types";
import type { GenerationSettings } from "../agent/types";
import type { AgentRegistry } from "../agent/agent-registry";
import type { ContextProvider, ContextWindowOptions } from "../context/types";
import type { Session } from "../session/types";
import type { ToolResult } from "../tools/types";
import type { RunSubscriber } from "../events/types";

/** New input for a run: raw text (→ a user message), a single message, or several. */
export type RunInput = string | Message | Message[];

/** A single event emitted over the course of a run. */
export type RunEvent =
  | { readonly type: "run.start"; readonly agent: string }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "token"; readonly delta: string }
  | { readonly type: "tool.call"; readonly id: string; readonly name: string; readonly arguments: unknown }
  | { readonly type: "tool.result"; readonly id: string; readonly name: string; readonly result: ToolResult }
  | { readonly type: "run.finish"; readonly result: RunResult }
  | { readonly type: "error"; readonly error: AgentError }
  /**
   * An event from a nested child run (e.g. a sub-agent invoked through
   * {@link RunBridge}). `agent` is the child's name and `depth` is its nesting
   * level relative to this run (1 for a direct child). Parent subscribers that
   * don't care about nesting can ignore this variant; those that do can recurse
   * into `event`.
   */
  | { readonly type: "agent.child"; readonly agent: string; readonly depth: number; readonly event: RunEvent }
  /**
   * The active agent handed the run off to another agent (Phase 7). `from` and
   * `to` are agent names. Emitted at the switch point; the message history is
   * preserved across the handoff.
   */
  | { readonly type: "agent.handoff"; readonly from: string; readonly to: string };

/**
 * A handle the run loop hands to a tool so it can participate in its parent run:
 * forward nested {@link RunEvent}s onto the parent's event stream and fold
 * nested token {@link Usage} into the parent run's aggregate. Used by
 * sub-agent-as-tool (`asTool`) to propagate a child run's events and usage
 * upward. Tools that ignore it behave exactly as before.
 */
export interface RunBridge {
  /** Forward a nested event onto the parent run's event stream. */
  emit(event: RunEvent): void;
  /** Add token usage from nested work into the parent run's running total. */
  reportUsage(usage: Usage): void;
}

/** Options for a single {@link runAgent} call. */
export interface RunOptions {
  /** New input for this run. */
  readonly input?: RunInput;
  /** Prior conversation prepended before `input`. Ignored when `session` is set (history comes from the session). */
  readonly messages?: Message[];
  /** Durable conversation: history is read before the run and new messages appended after it. */
  readonly session?: Session;
  /** Context providers injected into the system layer at run time (after instructions, before history). */
  readonly context?: readonly ContextProvider[];
  /** Token budgeting for the messages sent to the provider (does not affect persisted/returned history). */
  readonly contextWindow?: ContextWindowOptions;
  /** Per-run generation overrides, merged over the agent's `generation` defaults. */
  readonly generation?: GenerationSettings;
  /** Cap on provider turns (model→tools→model cycles). Defaults to {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number;
  /** Stream tokens + tool lifecycle. Omitted/`false` → buffered `Promise<RunResult>`. */
  readonly stream?: boolean;
  /** Event sink invoked for every {@link RunEvent}, in both buffered and streaming modes. */
  readonly onEvent?: (event: RunEvent) => void;
  /**
   * Additional independent event subscribers (UI streaming, audit log, metrics,
   * a `forge/messaging` bridge). Dispatched after {@link RunOptions.onEvent}, in
   * order, awaited per event. A subscriber that throws/rejects is isolated — it
   * neither aborts the run nor starves the others.
   */
  readonly subscribers?: readonly RunSubscriber[];
  /** Forge telemetry handle, threaded to provider calls / tools / hooks. */
  readonly telemetry?: TelemetryHandle;
  /** Structured logger (defaults to `telemetry.log`). */
  readonly logger?: Logger;
  /** Cancellation signal; halts the loop and in-flight provider/tool calls. */
  readonly signal?: AbortSignal;
  /**
   * Cap on agent handoffs in a single run, to bound triage↔specialist
   * ping-pong (Phase 7). Defaults to {@link DEFAULT_MAX_HANDOFFS}. Exceeding it
   * throws {@link MaxHandoffsExceededError}.
   */
  readonly maxHandoffs?: number;
  /**
   * Registry used to resolve string-named {@link AgentDefinition.handoffs}
   * targets (Phase 7). Not needed when every handoff target is given directly
   * as an {@link AgentDefinition}.
   */
  readonly registry?: AgentRegistry;
}

/** The buffered result of a completed run. */
export interface RunResult {
  /** Concatenated text of the final assistant message. */
  readonly output: string;
  /** The final assistant message. */
  readonly finalMessage: Message;
  /** Full history: prior messages + input + every assistant turn + tool results. */
  readonly messages: Message[];
  /** Why the loop ended. */
  readonly finishReason: FinishReason;
  /** Number of provider turns taken. */
  readonly steps: number;
  /** Token usage aggregated across all turns (zeros when unreported). */
  readonly usage: Usage;
  /**
   * Name of the agent that produced the final answer (Phase 7). Equals the
   * agent passed to {@link runAgent} unless the run handed off to another.
   */
  readonly agent: string;
  /**
   * Ordered trail of agent names the run handed off to (Phase 7). Empty when no
   * handoff occurred; the final entry equals {@link RunResult.agent}.
   */
  readonly handoffs: readonly string[];
}

/**
 * A streaming run: an async-iterable of {@link RunEvent}s, plus `completed`
 * which resolves with the final {@link RunResult} once the stream is fully
 * consumed (the same result is also delivered as the `run.finish` event).
 */
export type RunHandle = AsyncIterable<RunEvent> & {
  readonly completed: Promise<RunResult>;
};
