/**
 * The provider-neutral conversation model.
 *
 * Messages and their content parts are normalized so that history is
 * portable across providers (Phase 2 adapters translate to/from each
 * provider's native shape). `content` is *always* an array of parts.
 *
 * @module
 */

/** Who authored a message. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Plain text. */
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

/** An assistant request to invoke a tool. `arguments` is the raw (unvalidated) model output. */
export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * The outcome of a tool invocation, fed back to the model.
 *
 * Phase 3's structured `ToolResult` schema maps *into* this part; kept
 * minimal here so Phase 1 carries no forward dependency.
 */
export interface ToolResultPart {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: TextPart[];
  readonly isError?: boolean;
}

/** Image input. `data` is a base64 payload or a URL. */
export interface ImagePart {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}

/** Any content part a message may carry. */
export type ContentPart = TextPart | ToolCallPart | ToolResultPart | ImagePart;

/** A single normalized message. */
export interface Message {
  readonly role: Role;
  readonly content: ContentPart[];
  /** Optional author/tool name (e.g. for `role: "tool"`). */
  readonly name?: string;
  /** Free-form, host-defined metadata (never sent to providers). */
  readonly metadata?: Record<string, unknown>;
}
