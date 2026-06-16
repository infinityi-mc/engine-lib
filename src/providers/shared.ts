/**
 * Small mapping helpers shared by the provider adapters.
 *
 * @module
 */

import type {
  ImagePart,
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../messages/types";
import type { FinishReason } from "./types";

/**
 * Resolve an {@link ImagePart} to a value usable in an `image_url`-style field:
 * an `http(s)` URL is passed through, raw base64 is wrapped as a `data:` URI.
 */
export function imageDataUrl(part: ImagePart): string {
  if (/^data:/i.test(part.data)) return part.data;
  return /^https?:\/\//.test(part.data)
    ? part.data
    : `data:${part.mimeType};base64,${part.data}`;
}

/** Concatenated text of every `system` message, or `undefined` if none. */
export function systemText(messages: readonly Message[]): string | undefined {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Messages excluding `system` (which providers carry out-of-band). */
export function withoutSystem(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.role !== "system");
}

/** Join the text of a tool-result's content parts. */
export function toolResultText(part: ToolResultPart): string {
  return part.content.map((p) => p.text).join("");
}

/** Type guards for content parts. */
export const isText = (p: { type: string }): p is TextPart => p.type === "text";
export const isToolCall = (p: { type: string }): p is ToolCallPart =>
  p.type === "tool_call";
export const isToolResult = (p: { type: string }): p is ToolResultPart =>
  p.type === "tool_result";

/** Parse a JSON arguments string, tolerating empty/invalid input. */
export function parseJsonArguments(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Serialize tool-call arguments to the JSON string providers expect. */
export function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "{}";
  return JSON.stringify(value);
}

/** A `finish`-style normalization shared where vendors use the same buckets. */
export function defaultFinish(
  hadToolCalls: boolean,
  base: FinishReason,
): FinishReason {
  return hadToolCalls && base === "stop" ? "tool_calls" : base;
}
