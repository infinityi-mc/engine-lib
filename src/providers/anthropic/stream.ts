/**
 * Translate Anthropic Messages SSE events into the unified stream.
 *
 * @module
 */

import { ProviderError } from "../../errors";
import type { SseMessage } from "../sse";
import type { StreamEvent } from "../stream";
import type { Usage } from "../types";
import { mapStopReason } from "./map";

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { model?: string; usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
}

/** Translate Anthropic SSE messages into {@link StreamEvent}s. */
export async function* translateAnthropicStream(
  messages: AsyncIterable<SseMessage>,
  model: string,
): AsyncIterable<StreamEvent> {
  const toolIndexes = new Set<number>();
  let lastToolIndex: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null | undefined;
  let hadToolCalls = false;
  let sawUsage = false;
  let finished = false;

  const finishEvent = (includeUsage = sawUsage): StreamEvent => {
    const usage: Usage | undefined = includeUsage
      ? {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        }
      : undefined;
    return {
      type: "finish",
      finishReason: mapStopReason(stopReason, hadToolCalls),
      ...(usage !== undefined ? { usage } : {}),
    };
  };

  for await (const message of messages) {
    if (message.data === "") continue;
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(message.data) as AnthropicStreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "message_start":
        if (event.message?.usage?.input_tokens !== undefined) {
          inputTokens = event.message.usage.input_tokens;
          sawUsage = true;
        }
        yield { type: "message_start", model: event.message?.model ?? model };
        break;
      case "content_block_start":
        if (
          event.content_block?.type === "tool_use" &&
          event.index !== undefined
        ) {
          toolIndexes.add(event.index);
          lastToolIndex = event.index;
          hadToolCalls = true;
          yield {
            type: "tool_call_start",
            index: event.index,
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
          };
        }
        break;
      case "content_block_delta":
        if (
          event.delta?.type === "text_delta" &&
          event.delta.text !== undefined
        ) {
          yield { type: "text_delta", text: event.delta.text };
        } else if (
          event.delta?.type === "input_json_delta" &&
          event.delta.partial_json !== undefined
        ) {
          const index = event.index ?? lastToolIndex;
          if (index !== undefined) {
            yield {
              type: "tool_call_delta",
              index,
              argumentsTextDelta: event.delta.partial_json,
            };
          } else {
            yield {
              type: "error",
              error: new ProviderError(
                "Anthropic stream input_json_delta missing index",
                { provider: "anthropic" },
              ),
            };
          }
        }
        break;
      case "content_block_stop":
        if (event.index !== undefined && toolIndexes.has(event.index)) {
          yield { type: "tool_call_end", index: event.index };
          toolIndexes.delete(event.index);
          if (lastToolIndex === event.index) lastToolIndex = undefined;
        }
        break;
      case "message_delta":
        if (event.delta?.stop_reason !== undefined)
          stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) {
          outputTokens = event.usage.output_tokens;
          sawUsage = true;
        }
        break;
      case "message_stop":
        finished = true;
        yield finishEvent(true);
        break;
      default:
        break;
    }
  }

  if (!finished) yield finishEvent();
}
