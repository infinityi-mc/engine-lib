/**
 * Translate OpenAI-compatible Chat Completions SSE chunks into the unified
 * stream. Tool-call arguments arrive incrementally and are keyed by the
 * provider's `tool_calls[].index`.
 *
 * @module
 */

import type { SseMessage } from "../sse";
import type { StreamEvent } from "../stream";
import type { Usage } from "../types";
import { mapChatFinish } from "./map";

interface ChatChunk {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Translate Chat Completions SSE chunks into {@link StreamEvent}s. */
export async function* translateChatStream(
  messages: AsyncIterable<SseMessage>,
  model: string,
): AsyncIterable<StreamEvent> {
  let started = false;
  const openTools = new Set<number>();
  let hadToolCalls = false;
  let finishReason: string | undefined;
  let usage: Usage | undefined;

  for await (const message of messages) {
    if (message.data === "" || message.data === "[DONE]") continue;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(message.data) as ChatChunk;
    } catch {
      continue;
    }

    if (!started) {
      started = true;
      yield { type: "message_start", model: chunk.model ?? model };
    }

    const choice = chunk.choices?.[0];
    if (choice?.delta?.content !== undefined && choice.delta.content !== null) {
      yield { type: "text_delta", text: choice.delta.content };
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      if (!openTools.has(index)) {
        openTools.add(index);
        hadToolCalls = true;
        yield {
          type: "tool_call_start",
          index,
          id: call.id ?? "",
          name: call.function?.name ?? "",
        };
      }
      if (
        call.id !== undefined ||
        call.function?.name !== undefined ||
        (call.function?.arguments !== undefined &&
          call.function.arguments !== "")
      ) {
        yield {
          type: "tool_call_delta",
          index,
          ...(call.id !== undefined ? { id: call.id } : {}),
          ...(call.function?.name !== undefined
            ? { name: call.function.name }
            : {}),
          argumentsTextDelta: call.function?.arguments ?? "",
        };
      }
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens:
          chunk.usage.total_tokens ??
          (chunk.usage.prompt_tokens ?? 0) +
            (chunk.usage.completion_tokens ?? 0),
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens !==
        undefined
          ? {
              reasoningTokens:
                chunk.usage.completion_tokens_details.reasoning_tokens,
            }
          : {}),
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              cachedInputTokens:
                chunk.usage.prompt_tokens_details.cached_tokens,
            }
          : {}),
      };
    }
  }

  for (const index of openTools) yield { type: "tool_call_end", index };
  yield {
    type: "finish",
    finishReason: mapChatFinish(finishReason, hadToolCalls),
    ...(usage !== undefined ? { usage } : {}),
  };
}
