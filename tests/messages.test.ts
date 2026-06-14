import { describe, expect, it } from "bun:test";

import {
  assistant,
  normalizeContent,
  system,
  text,
  toolResult,
  user,
} from "../src/messages/index";

describe("normalizeContent", () => {
  it("coerces a string into a single text part", () => {
    expect(normalizeContent("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("passes part arrays through unchanged", () => {
    const parts = [text("a"), text("b")];
    expect(normalizeContent(parts)).toBe(parts);
  });
});

describe("message factories", () => {
  it("build role-tagged messages with normalized content", () => {
    expect(system("you are helpful")).toEqual({
      role: "system",
      content: [{ type: "text", text: "you are helpful" }],
    });
    expect(user("hello").role).toBe("user");
    expect(assistant([text("hi")]).content).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("toolResult wraps output in a tool_result part", () => {
    const msg = toolResult("call_1", "done");
    expect(msg.role).toBe("tool");
    expect(msg.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "call_1",
        content: [{ type: "text", text: "done" }],
      },
    ]);
  });

  it("toolResult marks errors when requested", () => {
    const msg = toolResult("call_1", "boom", { isError: true });
    const part = msg.content[0];
    expect(part).toMatchObject({ type: "tool_result", isError: true });
  });
});
