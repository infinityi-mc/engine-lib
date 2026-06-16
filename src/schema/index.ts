/**
 * `@infinityi/engine-lib/schema` — the schema contract used to describe and validate
 * tool parameters and structured outputs.
 *
 * Providers read `Schema.jsonSchema`; the runtime calls `Schema.parse` to
 * validate model-supplied arguments at the boundary.
 *
 * @module
 */

export { s } from "./builder";
export { asSchema, fromJsonSchema, toJsonSchema } from "./json-schema";
export { validateJsonSchema } from "./validate";
export type {
  InferShape,
  ObjectShape,
  OptionalKeys,
  RequiredKeys,
} from "./builder";
export type {
  Infer,
  JsonSchema,
  OptionalSchema,
  SafeParseResult,
  Schema,
  SchemaIssue,
} from "./types";
export type { Path } from "./validate";
