import { describe, expect, it } from "bun:test";

import { s } from "../src/schema/index";
import {
  defineTool,
  renderToolContent,
  toProviderTool,
  toToolResultMessage,
} from "../src/tools/index";
import type { ToolContext, ToolDefinition } from "../src/tools/index";

const ctx: ToolContext = { toolCallId: "call_1" };

describe("defineTool", () => {
  it("infers argument types from the parameter schema", async () => {
    const readFile = defineTool({
      name: "read_file",
      description: "Read a file.",
      parameters: s.object({ path: s.string(), lines: s.optional(s.number({ int: true })) }),
      execute: async (args) => {
        // Compile-time inference check: `args` is { path: string; lines?: number }.
        const path: string = args.path;
        const lines: number | undefined = args.lines;
        return { ok: true, content: `${path}:${lines ?? 0}` };
      },
    });

    expect(readFile.name).toBe("read_file");
    expect(readFile.description).toBe("Read a file.");
    const result = await readFile.execute({ path: "a.ts", lines: 3 }, ctx);
    expect(result).toEqual({ ok: true, content: "a.ts:3" });
  });

  it("rejects an empty name", () => {
    expect(() =>
      defineTool({ name: "", parameters: s.object({}), execute: () => ({ ok: true, content: "" }) }),
    ).toThrow(TypeError);
  });

  it("returns a frozen definition", () => {
    const tool = defineTool({ name: "noop", parameters: s.object({}), execute: () => ({ ok: true, content: "" }) });
    expect(Object.isFrozen(tool)).toBe(true);
  });
});

describe("renderToolContent", () => {
  it("passes strings through", () => {
    expect(renderToolContent({ ok: true, content: "hello" })).toEqual([{ type: "text", text: "hello" }]);
  });

  it("JSON-encodes structured content", () => {
    expect(renderToolContent({ ok: true, content: { a: 1 } })).toEqual([
      { type: "text", text: '{"a":1}' },
    ]);
  });

  it("renders the error message of a failure", () => {
    expect(renderToolContent({ ok: false, error: "boom" })).toEqual([{ type: "text", text: "boom" }]);
  });

  it("renders null/undefined content as empty text", () => {
    expect(renderToolContent({ ok: true, content: null })).toEqual([{ type: "text", text: "" }]);
    expect(renderToolContent({ ok: true, content: undefined })).toEqual([{ type: "text", text: "" }]);
  });
});

describe("toToolResultMessage", () => {
  it("maps a success to a tool message without isError", () => {
    const msg = toToolResultMessage("call_1", { ok: true, content: "done" });
    expect(msg.role).toBe("tool");
    expect(msg.content).toEqual([
      { type: "tool_result", toolCallId: "call_1", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("maps a failure to a tool message with isError: true", () => {
    const msg = toToolResultMessage("call_2", { ok: false, error: "nope" });
    expect(msg.content[0]).toMatchObject({ type: "tool_result", toolCallId: "call_2", isError: true });
  });
});

describe("toProviderTool", () => {
  it("projects name, description, and JSON-Schema parameters", () => {
    const tool: ToolDefinition = defineTool({
      name: "search",
      description: "Search the web.",
      parameters: s.object({ query: s.string() }),
      execute: () => ({ ok: true, content: "" }),
    });

    expect(toProviderTool(tool)).toEqual({
      name: "search",
      description: "Search the web.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    });
  });

  it("omits description when absent", () => {
    const tool = defineTool({ name: "t", parameters: s.object({}), execute: () => ({ ok: true, content: "" }) });
    expect(toProviderTool(tool)).not.toHaveProperty("description");
  });
});
