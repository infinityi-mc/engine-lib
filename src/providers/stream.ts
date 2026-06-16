/**
 * The unified streaming model shared by every provider adapter.
 *
 * Each adapter translates its vendor's SSE events into this {@link StreamEvent}
 * union. The stable application contract is the `StreamEvent` union itself;
 * {@link StreamAccumulator} and {@link collectStream} are advanced helpers for
 * adapter authors, tests, and provider-subpath users.
 *
 * The shape follows the rule every provider doc calls out: assemble tool-call
 * arguments by **index**, never assume one flat string.
 *
 * @module
 */

import type { ProviderError } from "../errors";
import type { ContentPart, Message, ToolCallPart } from "../messages/types";
import type { CompletionResult, FinishReason, ToolCall, Usage } from "./types";

/**
 * A single normalized streaming event.
 *
 * A well-formed stream starts with `message_start`, then yields zero or more
 * text/tool-call delta events, and ends with `finish`. `error` may appear when
 * a provider reports a recoverable stream error; thrown stream failures surface
 * as `ProviderError`.
 *
 * Tool-call argument chunks are keyed by `index`: consumers must assemble
 * `tool_call_delta` events by index and wait for `tool_call_end`.
 */
export type StreamEvent =
  | { readonly type: "message_start"; readonly model: string }
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_call_start";
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsTextDelta: string;
    }
  | { readonly type: "tool_call_end"; readonly index: number }
  | {
      readonly type: "finish";
      readonly finishReason: FinishReason;
      readonly usage?: Usage;
    }
  | { readonly type: "error"; readonly error: ProviderError };

interface PartialToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

/** Parse tool-call argument text, tolerating empty / invalid JSON. */
function parseArguments(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Folds a {@link StreamEvent} sequence into a single {@link CompletionResult}.
 * Tool calls are keyed by their stream index so out-of-order deltas assemble
 * correctly.
 */
export class StreamAccumulator {
  private model?: string;
  private text = "";
  private finishReason: FinishReason = "stop";
  private usage?: Usage;
  private readonly toolCalls = new Map<number, PartialToolCall>();

  push(event: StreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.model = event.model;
        break;
      case "text_delta":
        this.text += event.text;
        break;
      case "tool_call_start":
        this.toolCalls.set(event.index, {
          id: event.id,
          name: event.name,
          argumentsText: "",
        });
        break;
      case "tool_call_delta": {
        const call = this.toolCalls.get(event.index);
        if (call) {
          if (event.id !== undefined) call.id = event.id;
          if (event.name !== undefined) call.name = event.name;
          call.argumentsText += event.argumentsTextDelta;
        }
        break;
      }
      case "tool_call_end":
        break;
      case "finish":
        this.finishReason = event.finishReason;
        if (event.usage !== undefined) this.usage = event.usage;
        break;
      case "error":
        this.finishReason = "error";
        break;
    }
  }

  /** Build the final result. `model` is a fallback when no `message_start` was seen. */
  result(model: string, raw?: unknown): CompletionResult {
    const resolvedModel = this.model ?? model;
    const ordered = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => c);

    const content: ContentPart[] = [];
    if (this.text !== "") content.push({ type: "text", text: this.text });
    for (const call of ordered) {
      const part: ToolCallPart = {
        type: "tool_call",
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.argumentsText),
      };
      content.push(part);
    }

    const message: Message = { role: "assistant", content };
    const toolCalls: ToolCall[] = ordered.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.argumentsText),
      argumentsText: call.argumentsText,
    }));

    return {
      message,
      toolCalls,
      finishReason:
        this.toolCalls.size > 0 && this.finishReason === "stop"
          ? "tool_calls"
          : this.finishReason,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      model: resolvedModel,
      raw,
    };
  }
}

/** Drain an event stream into a {@link CompletionResult}. */
export async function collectStream(
  events: AsyncIterable<StreamEvent>,
  model: string,
  raw?: unknown,
): Promise<CompletionResult> {
  const accumulator = new StreamAccumulator();
  for await (const event of events) accumulator.push(event);
  return accumulator.result(model, raw);
}
