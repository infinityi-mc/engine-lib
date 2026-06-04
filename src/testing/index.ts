/**
 * `engine-lib/testing` — in-memory helpers and assertions for tests.
 *
 * Phase 1 ships only the helpers relevant to the foundation layer;
 * provider and session doubles arrive with Phases 2 and 5.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type { Schema } from "../schema/types";

/** Build a `Message[]` from arguments, for readable test fixtures. */
export function conversation(...messages: Message[]): Message[] {
  return messages;
}

/**
 * Parse `input` with `schema`, returning the typed value. Throws (failing
 * the test) with a readable message listing all issues if invalid.
 */
export function expectValid<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`expected input to be valid, but: ${detail}`);
}
