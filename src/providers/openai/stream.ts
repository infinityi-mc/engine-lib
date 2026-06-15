/**
 * Translate OpenAI Responses SSE events into the unified stream.
 *
 * @module
 */

import type { SseMessage } from "../sse";
import type { StreamEvent } from "../stream";
import type { FinishReason } from "../types";
import { parseOpenAIResponse } from "./map";

interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  call_id?: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  response?: unknown;
}

/** Translate Responses SSE messages into {@link StreamEvent}s. */
export async function* translateOpenAIStream(
  messages: AsyncIterable<SseMessage>,
  model: string,
): AsyncIterable<StreamEvent> {
  let nextIndex = 0;
  const indexByItem = new Map<string, number>();
  const openToolIndexes = new Set<number>();
  let started = false;
  let hadToolCalls = false;
  let finished = false;

  const fallbackFinishReason = (): FinishReason =>
    hadToolCalls ? "tool_calls" : "stop";

  const indexForEvent = (event: OpenAIStreamEvent): number | undefined => {
    const key = event.item_id ?? event.call_id;
    return key !== undefined ? indexByItem.get(key) : undefined;
  };

  function* closeOpenToolCalls(): Generator<StreamEvent> {
    for (const index of openToolIndexes) yield { type: "tool_call_end", index };
    openToolIndexes.clear();
  }

  for await (const message of messages) {
    if (message.data === "" || message.data === "[DONE]") continue;
    let event: OpenAIStreamEvent;
    try {
      event = JSON.parse(message.data) as OpenAIStreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "response.created":
        if (!started) {
          started = true;
          yield { type: "message_start", model };
        }
        break;
      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          const index = nextIndex++;
          hadToolCalls = true;
          if (event.item.id !== undefined) indexByItem.set(event.item.id, index);
          if (event.item.call_id !== undefined)
            indexByItem.set(event.item.call_id, index);
          openToolIndexes.add(index);
          yield {
            type: "tool_call_start",
            index,
            id: event.item.call_id ?? event.item.id ?? "",
            name: event.item.name ?? "",
          };
        }
        break;
      case "response.output_text.delta":
        if (event.delta !== undefined)
          yield { type: "text_delta", text: event.delta };
        break;
      case "response.function_call_arguments.delta": {
        const index = indexForEvent(event);
        if (index !== undefined && event.delta !== undefined) {
          yield {
            type: "tool_call_delta",
            index,
            argumentsTextDelta: event.delta,
          };
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const index = indexForEvent(event);
        if (index !== undefined && openToolIndexes.has(index)) {
          openToolIndexes.delete(index);
          yield { type: "tool_call_end", index };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        finished = true;
        yield* closeOpenToolCalls();
        const result = parseOpenAIResponse(event.response, model);
        yield {
          type: "finish",
          finishReason: result.finishReason,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        };
        break;
      }
      default:
        break;
    }
  }

  if (!finished) {
    yield* closeOpenToolCalls();
    yield { type: "finish", finishReason: fallbackFinishReason() };
  }
}
