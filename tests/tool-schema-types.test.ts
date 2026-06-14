import { describe, expect, it } from "bun:test";

import { s, type Infer } from "../src/schema/index";
import {
  defineTool,
  type ToolContext,
  type ToolResult,
} from "../src/tools/index";

const ctx = undefined as unknown as ToolContext;

function assertToolAndSchemaTypes(): void {
  const params = s.object({
    path: s.string(),
    maxBytes: s.optional(s.number({ int: true })),
    mode: s.enum(["text", "binary"] as const),
  });

  type Params = Infer<typeof params>;
  const withOptional: Params = {
    path: "README.md",
    mode: "text",
    maxBytes: 1024,
  };
  const withoutOptional: Params = { path: "README.md", mode: "text" };
  void [withOptional, withoutOptional];

  // @ts-expect-error path is required.
  const missingRequired: Params = { mode: "text" };
  const wrongOptionalType: Params = {
    path: "README.md",
    mode: "text",
    // @ts-expect-error maxBytes is a number when present.
    maxBytes: "1024",
  };
  void [missingRequired, wrongOptionalType];

  const readFile = defineTool({
    name: "read_file",
    parameters: params,
    execute: async (args) => {
      const path: string = args.path;
      const maxBytes: number | undefined = args.maxBytes;
      const mode: "text" | "binary" = args.mode;

      // @ts-expect-error path is inferred as string, not number.
      const badPath: number = args.path;
      // @ts-expect-error optional fields may be undefined.
      const requiredMaxBytes: number = args.maxBytes;
      void [badPath, requiredMaxBytes];

      return { ok: true, content: { path, maxBytes, mode } };
    },
  });

  readFile.execute({ path: "README.md", mode: "text" }, ctx);
  readFile.execute({ path: "README.md", mode: "binary", maxBytes: 1024 }, ctx);
  // @ts-expect-error missing required path.
  readFile.execute({ mode: "text" }, ctx);
  // @ts-expect-error unknown object keys are not part of the inferred tool args.
  readFile.execute({ path: "README.md", mode: "text", extra: true }, ctx);

  const success: ToolResult = { ok: true, content: "done" };
  const failure: ToolResult = { ok: false, error: "file not found" };
  // @ts-expect-error success results must include content.
  const missingContent: ToolResult = { ok: true };
  // @ts-expect-error failure error is intentionally a string.
  const structuredError: ToolResult = { ok: false, error: { message: "nope" } };
  void [success, failure, missingContent, structuredError];
}

describe("tool/schema type contract", () => {
  it("keeps defineTool inference and ToolResult discriminants stable", () => {
    void assertToolAndSchemaTypes;
    expect(true).toBe(true);
  });
});
