/**
 * Constructors and normalization helpers for the message model.
 *
 * {@link normalizeContent} is the single seam that coerces a bare string
 * into `[text(string)]`, so every other factory and (later) provider
 * adapter can assume `content` is always an array of parts.
 *
 * @module
 */

import type { ContentPart, ImagePart, Message, TextPart } from "./types";

const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/** A {@link TextPart}. */
export function text(value: string): TextPart {
  return { type: "text", text: value };
}

/** An {@link ImagePart} from an http(s) URL, data URL, or raw base64 payload. */
export function image(data: string, mimeType: string): ImagePart {
  const normalizedMimeType = mimeType.trim();
  if (!MIME_TYPE_RE.test(normalizedMimeType)) {
    throw new TypeError("image mimeType must be a valid type/subtype");
  }
  const isHttpUrl = /^https?:\/\//.test(data);
  const isDataUrl = /^data:[^;,]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(data);
  const isBase64 = data.length > 0 && BASE64_RE.test(data);
  if (!isHttpUrl && !isDataUrl && !isBase64) {
    throw new TypeError(
      "image data must be an http(s) URL, data URL, or base64 payload",
    );
  }
  return { type: "image", mimeType: normalizedMimeType, data };
}

/** Coerce `string` → `[text(string)]`; pass part arrays through unchanged. */
export function normalizeContent(
  content: string | ContentPart[],
): ContentPart[] {
  return typeof content === "string" ? [text(content)] : content;
}

/** A text-only `system` message. Provider adapters carry system text out-of-band. */
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
  const content: TextPart[] =
    typeof output === "string" ? [text(output)] : output;
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
