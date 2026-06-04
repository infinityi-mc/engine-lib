/**
 * Helpers for moving between {@link Schema} and raw {@link JsonSchema}.
 *
 * @module
 */

import { SchemaValidationError } from "../errors";
import type { JsonSchema, SafeParseResult, Schema } from "./types";
import { validateJsonSchema } from "./validate";

/** Return the provider-facing {@link JsonSchema} for a schema. */
export function toJsonSchema<T>(schema: Schema<T>): JsonSchema {
  return schema.jsonSchema;
}

/**
 * Adapt an external schema implementation (e.g. a Zod adapter) into the
 * engine-lib {@link Schema} contract. Only `jsonSchema` and `parse` are
 * required; `safeParse` is derived if absent.
 */
export function asSchema<T>(
  impl: Pick<Schema<T>, "jsonSchema" | "parse"> & Partial<Pick<Schema<T>, "safeParse">>,
): Schema<T> {
  return {
    jsonSchema: impl.jsonSchema,
    parse: impl.parse.bind(impl),
    safeParse:
      impl.safeParse?.bind(impl) ??
      ((input: unknown): SafeParseResult<T> => {
        try {
          return { success: true, data: impl.parse(input) };
        } catch (error) {
          if (error instanceof SchemaValidationError) return { success: false, error };
          return {
            success: false,
            error: new SchemaValidationError("schema validation failed", {
              cause: error,
              issues: [{ path: [], message: String(error) }],
            }),
          };
        }
      }),
  };
}

/**
 * Wrap a raw {@link JsonSchema} as a {@link Schema}. Validation uses the
 * built-in validator; the output type is supplied by the caller (`T`).
 */
export function fromJsonSchema<T = unknown>(jsonSchema: JsonSchema): Schema<T> {
  return {
    jsonSchema,
    safeParse(input: unknown): SafeParseResult<T> {
      const issues = validateJsonSchema(jsonSchema, input);
      if (issues.length === 0) return { success: true, data: input as T };
      return {
        success: false,
        error: new SchemaValidationError("schema validation failed", { issues }),
      };
    },
    parse(input: unknown): T {
      const result = this.safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
  };
}
