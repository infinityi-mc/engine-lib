import { describe, expect, it } from "bun:test";

import { SchemaValidationError, ToolValidationError } from "../src/errors";
import { asSchema, fromJsonSchema, s, toJsonSchema } from "../src/schema/index";
import type { Infer } from "../src/schema/index";

describe("s — JSON Schema generation", () => {
  it("emits primitives", () => {
    expect(s.string().jsonSchema).toEqual({ type: "string" });
    expect(s.number().jsonSchema).toEqual({ type: "number" });
    expect(s.number({ int: true }).jsonSchema).toEqual({ type: "integer" });
    expect(s.boolean().jsonSchema).toEqual({ type: "boolean" });
    expect(s.enum(["a", "b"]).jsonSchema).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("emits nested objects with required derived from optionality", () => {
    const schema = s.object({
      service: s.string(),
      lines: s.optional(s.number({ int: true })),
      tags: s.array(s.string()),
    });

    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        lines: { type: ["integer", "null"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["service", "tags"],
    });
  });

  it("emits nullable JSON Schema for optional enums", () => {
    const schema = s.object({
      mode: s.optional(s.enum(["fast", "safe"])),
    });

    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: ["string", "null"], enum: ["fast", "safe", null] },
      },
    });
  });

  it("rejects s.optional() as an array item schema", () => {
    expect(() => s.array(s.optional(s.string()))).toThrow(TypeError);
    expect(() => s.array(s.optional(s.string()))).toThrow(
      /cannot be used as an array item schema/,
    );
  });
});

describe("s — validation", () => {
  const schema = s.object({
    service: s.string(),
    lines: s.optional(s.number({ int: true })),
  });
  type Params = Infer<typeof schema>;

  it("parses valid input and infers the type", () => {
    const value: Params = schema.parse({ service: "api", lines: 10 });
    expect(value).toEqual({ service: "api", lines: 10 });
    // optional may be omitted
    expect(schema.parse({ service: "api" })).toEqual({ service: "api" });
    // providers often send null for omitted optional fields
    expect(schema.parse({ service: "api", lines: null })).toEqual({
      service: "api",
    });
  });

  it("coerces optional enum nulls to undefined after object validation", () => {
    const schema = s.object({
      mode: s.optional(s.enum(["fast", "safe"])),
    });

    expect(schema.parse({ mode: null })).toEqual({});
  });

  it("collects all issues via safeParse", () => {
    const result = schema.safeParse({ lines: 1.5 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("service"); // required & missing
    expect(paths).toContain("lines"); // not an integer
  });

  it("rejects unknown properties", () => {
    const result = schema.safeParse({ service: "api", extra: true });
    expect(result.success).toBe(false);
  });

  it("rejects prototype-named additional properties", () => {
    const empty = s.object({});
    expect(empty.safeParse({ toString: "evil" }).success).toBe(false);
    expect(empty.safeParse({ constructor: "evil" }).success).toBe(false);
  });

  it("does not satisfy required fields from inherited properties", () => {
    const raw = fromJsonSchema<{ toString: string }>({
      type: "object",
      properties: { toString: { type: "string" as const } },
      required: ["toString"],
      additionalProperties: false,
    });

    const missing = raw.safeParse({});
    expect(missing.success).toBe(false);
    if (!missing.success)
      expect(missing.error.issues[0]?.message).toBe("required");
    expect(raw.safeParse({ toString: "ok" }).success).toBe(true);
  });

  it("rejects Infinity and -Infinity for number types", () => {
    const numberSchema = s.number();
    expect(numberSchema.safeParse(Infinity).success).toBe(false);
    expect(numberSchema.safeParse(-Infinity).success).toBe(false);
    expect(numberSchema.safeParse(NaN).success).toBe(false);
  });

  it("enforces maxItems constraint on arrays", () => {
    const limited = s.array(s.string(), { maxItems: 2 });
    expect(limited.safeParse(["a", "b"]).success).toBe(true);

    const result = limited.safeParse(["a", "b", "c"]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at most 2 items/);
    }
  });

  it("throws SchemaValidationError from parse", () => {
    expect(() => schema.parse({})).toThrow(SchemaValidationError);
  });
});

describe("adapters", () => {
  it("fromJsonSchema validates against a raw schema", () => {
    const schema = fromJsonSchema<{ n: number }>({
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    });
    expect(schema.parse({ n: 1 })).toEqual({ n: 1 });
    expect(schema.safeParse({ n: "x" }).success).toBe(false);
  });

  it("asSchema derives safeParse from a parse-only impl", () => {
    const schema = asSchema<number>({
      jsonSchema: { type: "number" },
      parse: (input) => {
        if (typeof input !== "number") {
          throw new ToolValidationError("not a number", {
            toolName: "t",
            issues: [{ path: [], message: "expected number" }],
          });
        }
        return input;
      },
    });
    expect(schema.parse(3)).toBe(3);
    const result = schema.safeParse("x");
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error).toBeInstanceOf(SchemaValidationError);
  });
});
