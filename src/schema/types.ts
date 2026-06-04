/**
 * Core types for the `engine-lib` schema layer.
 *
 * The {@link Schema} contract is the seam between engine-lib and LLM
 * providers: providers read `.jsonSchema` (to advertise tool parameters
 * / structured outputs), while the runtime calls `.parse` to validate
 * model-supplied arguments at the boundary.
 *
 * @module
 */

import type { SchemaIssue, SchemaValidationError } from "../errors";

/**
 * A structural subset of JSON Schema (draft 2020-12) sufficient to
 * describe tool parameters and structured outputs for every supported
 * provider. Intentionally minimal and extensible.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  /** Object: property schemas. */
  properties?: Record<string, JsonSchema>;
  /** Object: required property names. */
  required?: string[];
  /** Object: whether unknown properties are permitted (default `false`). */
  additionalProperties?: boolean;
  /** Array: element schema. */
  items?: JsonSchema;
  /** Enumerated allowed values. */
  enum?: ReadonlyArray<string | number>;
}

/** Result of a non-throwing parse. */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaValidationError };

/**
 * The engine-lib schema contract. A `Schema<T>` couples a provider-facing
 * {@link JsonSchema} with runtime validation that yields a typed `T`.
 */
export interface Schema<T> {
  /** Provider-facing JSON Schema (consumed by provider adapters in Phase 2+). */
  readonly jsonSchema: JsonSchema;
  /** Validate and return `T`, or throw {@link SchemaValidationError}. */
  parse(input: unknown): T;
  /** Validate without throwing. */
  safeParse(input: unknown): SafeParseResult<T>;
  /** Phantom marker carrying the output type for {@link Infer}. Never present at runtime. */
  readonly _output?: T;
}

/**
 * A schema marked optional by `s.optional`. The `__optional` marker is a
 * phantom (never present at runtime) used purely to make the corresponding
 * object key optional in {@link Infer}.
 */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly __optional: true;
}

/** Infer the TypeScript type carried by a {@link Schema}. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

export type { SchemaIssue };
