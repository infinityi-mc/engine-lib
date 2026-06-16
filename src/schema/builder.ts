/**
 * The `s` builder — the public entry point for declaring schemas.
 *
 * `s` constructs {@link Schema} values for the JSON-Schema-expressible types
 * engine-lib needs to describe tool parameters and structured outputs. Objects
 * are strict by default (`additionalProperties: false`), and fields wrapped in
 * `s.optional()` infer as optional TypeScript properties. It is intentionally
 * dependency-free; external schema libraries (e.g. Zod) plug in through
 * `asSchema` rather than as a hard dependency.
 *
 * @example
 * ```ts
 * import { s, type Infer } from "@infinityi/engine-lib/schema";
 *
 * const Params = s.object({
 *   service: s.string(),
 *   lines: s.optional(s.number({ int: true })),
 * });
 * type Params = Infer<typeof Params>; // { service: string; lines?: number }
 * ```
 *
 * @module
 */

import { SchemaValidationError } from "../errors";
import type {
  JsonSchema,
  OptionalSchema,
  SafeParseResult,
  Schema,
} from "./types";
import { validateJsonSchema } from "./validate";

type JsonSchemaType = NonNullable<JsonSchema["type"]>;

/** Tracks which schemas were produced by `s.optional` (excluded from `required`). */
const optionalSchemas = new WeakSet<object>();

/** Build a {@link Schema} whose validation is driven by `jsonSchema`. */
function makeSchema<T>(jsonSchema: JsonSchema): Schema<T> {
  return {
    jsonSchema,
    safeParse(input: unknown): SafeParseResult<T> {
      const issues = validateJsonSchema(jsonSchema, input);
      if (issues.length === 0) return { success: true, data: input as T };
      return {
        success: false,
        error: new SchemaValidationError("schema validation failed", {
          issues,
        }),
      };
    },
    parse(input: unknown): T {
      const result = this.safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
  };
}

type ObjectShape = Record<string, Schema<unknown>>;
type OptionalKeys<P extends ObjectShape> = {
  [K in keyof P]: P[K] extends OptionalSchema<unknown> ? K : never;
}[keyof P];
type RequiredKeys<P extends ObjectShape> = Exclude<keyof P, OptionalKeys<P>>;
type InferShape<P extends ObjectShape> = {
  [K in RequiredKeys<P>]: P[K] extends Schema<infer T> ? T : never;
} & {
  [K in OptionalKeys<P>]?: P[K] extends Schema<infer T>
    ? Exclude<T, undefined>
    : never;
};

/** Public schema-builder surface. */
export const s = {
  /** A string, optionally constrained to an enum. */
  string(opts?: {
    description?: string;
    enum?: readonly string[];
  }): Schema<string> {
    const node: JsonSchema = { type: "string" };
    if (opts?.description !== undefined) node.description = opts.description;
    if (opts?.enum !== undefined) node.enum = opts.enum;
    return makeSchema<string>(node);
  },

  /** A number. Pass `{ int: true }` to require an integer. */
  number(opts?: { description?: string; int?: boolean }): Schema<number> {
    const node: JsonSchema = { type: opts?.int ? "integer" : "number" };
    if (opts?.description !== undefined) node.description = opts.description;
    return makeSchema<number>(node);
  },

  /** A boolean. */
  boolean(opts?: { description?: string }): Schema<boolean> {
    const node: JsonSchema = { type: "boolean" };
    if (opts?.description !== undefined) node.description = opts.description;
    return makeSchema<boolean>(node);
  },

  /** One of a fixed set of string variants. */
  enum<V extends string>(
    values: readonly V[],
    opts?: { description?: string },
  ): Schema<V> {
    const node: JsonSchema = { type: "string", enum: values };
    if (opts?.description !== undefined) node.description = opts.description;
    return makeSchema<V>(node);
  },

  /** An array of `item`. */
  array<T>(
    item: Schema<T>,
    opts?: { description?: string; maxItems?: number },
  ): Schema<T[]> {
    if (optionalSchemas.has(item)) {
      throw new TypeError(
        "s.optional() cannot be used as an array item schema",
      );
    }
    const node: JsonSchema = { type: "array", items: item.jsonSchema };
    if (opts?.description !== undefined) node.description = opts.description;
    if (opts?.maxItems !== undefined) node.maxItems = opts.maxItems;
    return makeSchema<T[]>(node);
  },

  /**
   * An object with the given properties. Properties wrapped in
   * {@link s.optional} are excluded from `required`; all others are required.
   * Unknown properties are rejected (`additionalProperties: false`).
   */
  object<P extends ObjectShape>(
    props: P,
    opts?: { description?: string },
  ): Schema<InferShape<P>> {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      properties[key] = prop.jsonSchema;
      if (!optionalSchemas.has(prop)) required.push(key);
    }
    const node: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) node.required = required;
    if (opts?.description !== undefined) node.description = opts.description;
    return {
      jsonSchema: node,
      safeParse(input: unknown): SafeParseResult<InferShape<P>> {
        const issues = validateJsonSchema(node, input);
        if (issues.length > 0) {
          return {
            success: false,
            error: new SchemaValidationError("schema validation failed", {
              issues,
            }),
          };
        }

        const out: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(props)) {
          if (!Object.hasOwn(input as Record<string, unknown>, key)) continue;
          const result = prop.safeParse(
            (input as Record<string, unknown>)[key],
          );
          if (!result.success) return result as SafeParseResult<InferShape<P>>;
          if (result.data !== undefined) out[key] = result.data;
        }
        return { success: true, data: out as InferShape<P> };
      },
      parse(input: unknown): InferShape<P> {
        const result = this.safeParse(input);
        if (!result.success) throw result.error;
        return result.data;
      },
    };
  },

  /** Mark a schema optional: `undefined` validates, and object keys become non-required. */
  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    const innerType = inner.jsonSchema.type;
    const nullableType: JsonSchema["type"] =
      innerType === undefined
        ? undefined
        : Array.isArray(innerType)
          ? innerType.includes("null")
            ? innerType
            : ([...innerType, "null"] as JsonSchemaType)
          : innerType === "null"
            ? "null"
            : ([innerType, "null"] as JsonSchemaType);
    const nullableEnum =
      inner.jsonSchema.enum === undefined ||
      inner.jsonSchema.enum.includes(null)
        ? inner.jsonSchema.enum
        : [...inner.jsonSchema.enum, null];
    const jsonSchema: JsonSchema = {
      ...inner.jsonSchema,
      ...(nullableType !== undefined ? { type: nullableType } : {}),
      ...(nullableEnum !== undefined ? { enum: nullableEnum } : {}),
    };
    const schema: Schema<T | undefined> = {
      jsonSchema,
      safeParse(input: unknown): SafeParseResult<T | undefined> {
        if (input === undefined || input === null) {
          return { success: true, data: undefined };
        }
        return inner.safeParse(input);
      },
      parse(input: unknown): T | undefined {
        const result = this.safeParse(input);
        if (!result.success) throw result.error;
        return result.data;
      },
    };
    optionalSchemas.add(schema);
    // `__optional` is a phantom type-only marker; it is never present at runtime.
    return schema as OptionalSchema<T>;
  },
} as const;
