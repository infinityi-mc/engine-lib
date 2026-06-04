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
import type { ToolResult } from "../tools/types";

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
  | { readonly type: "error"; readonly error: AgentError };

/** Options for a single {@link runAgent} call. */
export interface RunOptions {
  /** New input for this run. */
  readonly input?: RunInput;
  /** Prior conversation prepended before `input` (Phase 5 sources this from a session). */
  readonly messages?: Message[];
  /** Per-run generation overrides, merged over the agent's `generation` defaults. */
  readonly generation?: GenerationSettings;
  /** Cap on provider turns (model→tools→model cycles). Defaults to {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number;
  /** Stream tokens + tool lifecycle. Omitted/`false` → buffered `Promise<RunResult>`. */
  readonly stream?: boolean;
  /** Event sink invoked for every {@link RunEvent}, in both buffered and streaming modes. */
  readonly onEvent?: (event: RunEvent) => void;
  /** Forge telemetry handle, threaded to provider calls / tools / hooks. */
  readonly telemetry?: TelemetryHandle;
  /** Structured logger (defaults to `telemetry.log`). */
  readonly logger?: Logger;
  /** Cancellation signal; halts the loop and in-flight provider/tool calls. */
  readonly signal?: AbortSignal;
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
}

/**
 * A streaming run: an async-iterable of {@link RunEvent}s, plus `completed`
 * which resolves with the final {@link RunResult} once the stream is fully
 * consumed (the same result is also delivered as the `run.finish` event).
 */
export type RunHandle = AsyncIterable<RunEvent> & {
  readonly completed: Promise<RunResult>;
};
