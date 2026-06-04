/**
 * `engine-lib/messages` — the provider-neutral conversation model and its
 * constructors.
 *
 * @module
 */

export {
  assistant,
  normalizeContent,
  system,
  text,
  toolResult,
  user,
} from "./factory";
export type {
  ContentPart,
  ImagePart,
  Message,
  Role,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./types";
