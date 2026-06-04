/**
 * Constructors and normalization helpers for the message model.
 *
 * {@link normalizeContent} is the single seam that coerces a bare string
 * into `[text(string)]`, so every other factory and (later) provider
 * adapter can assume `content` is always an array of parts.
 *
 * @module
 */

import type { ContentPart, Message, TextPart } from "./types";

/** A {@link TextPart}. */
export function text(value: string): TextPart {
  return { type: "text", text: value };
}

/** Coerce `string` → `[text(string)]`; pass part arrays through unchanged. */
export function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  return typeof content === "string" ? [text(content)] : content;
}

/** A `system` message. */
export function system(content: string): Message {
  return { role: "system", content: normalizeContent(content) };
}

/** A `user` message. */
export function user(content: string | ContentPart[]): Message {
  return { role: "user", content: normalizeContent(content) };
}

/** An `assistant` message. */
export function assistant(content: string | ContentPart[]): Message {
  return { role: "assistant", content: normalizeContent(content) };
}

/** A `tool` message carrying the result of a single tool call. */
export function toolResult(
  toolCallId: string,
  output: string | TextPart[],
  opts?: { isError?: boolean },
): Message {
  const content: TextPart[] = typeof output === "string" ? [text(output)] : output;
  return {
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId,
        content,
        ...(opts?.isError !== undefined ? { isError: opts.isError } : {}),
      },
    ],
  };
}
