/**
 * Translate Gemini `streamGenerateContent?alt=sse` chunks into the unified
 * stream. Gemini delivers whole `functionCall`s per chunk (no incremental
 * argument deltas), so each is emitted as a start/delta/end triple.
 *
 * @module
 */

import type { SseMessage } from "../sse";
import type { StreamEvent } from "../stream";
import type { Usage } from "../types";
import { mapGoogleFinish } from "./map";

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/** Translate Gemini SSE chunks into {@link StreamEvent}s. */
export async function* translateGoogleStream(
  messages: AsyncIterable<SseMessage>,
  model: string,
): AsyncIterable<StreamEvent> {
  let started = false;
  let toolIndex = 0;
  let hadToolCalls = false;
  let finishReason: string | undefined;
  let usage: Usage | undefined;

  for await (const message of messages) {
    if (message.data === "") continue;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(message.data) as GeminiChunk;
    } catch {
      continue;
    }

    if (!started) {
      started = true;
      yield { type: "message_start", model };
    }

    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined) {
        yield { type: "text_delta", text: part.text };
      } else if (part.functionCall !== undefined) {
        const index = toolIndex++;
        hadToolCalls = true;
        const name = part.functionCall.name ?? "";
        yield { type: "tool_call_start", index, id: part.functionCall.id ?? `call_${name}_${index}`, name };
        yield {
          type: "tool_call_delta",
          index,
          argumentsTextDelta: JSON.stringify(part.functionCall.args ?? {}),
        };
        yield { type: "tool_call_end", index };
      }
    }
    if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason;

    if (chunk.usageMetadata) {
      const meta = chunk.usageMetadata;
      usage = {
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: meta.candidatesTokenCount ?? 0,
        totalTokens: meta.totalTokenCount ?? (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        ...(meta.thoughtsTokenCount !== undefined ? { reasoningTokens: meta.thoughtsTokenCount } : {}),
        ...(meta.cachedContentTokenCount !== undefined ? { cachedInputTokens: meta.cachedContentTokenCount } : {}),
      };
    }
  }

  yield {
    type: "finish",
    finishReason: mapGoogleFinish(finishReason, hadToolCalls),
    ...(usage !== undefined ? { usage } : {}),
  };
}
