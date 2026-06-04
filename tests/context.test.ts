import { describe, expect, it } from "bun:test";

import { ContextWindowError } from "../src/errors";
import { assistant, system, user } from "../src/messages/index";
import type { Message } from "../src/messages/types";
import {
  dynamicContext,
  estimateTokens,
  resolveContext,
  staticContext,
  summarizeOldest,
  truncateOldest,
} from "../src/context/index";
import { mockProvider } from "../src/testing/index";

function textOf(message: Message): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

describe("context providers", () => {
  it("staticContext renders a string verbatim with an optional title", async () => {
    const msgs = await resolveContext([staticContext("plain facts", "Facts")], {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("system");
    expect(textOf(msgs[0]!)).toBe("## Facts\nplain facts");
  });

  it("staticContext JSON-encodes non-string content", async () => {
    const msgs = await resolveContext([staticContext({ a: 1 })], {});
    expect(textOf(msgs[0]!)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("dynamicContext resolves lazily from EngineContext", async () => {
    const provider = dynamicContext("clock", () => "now=42");
    const msgs = await resolveContext([provider], {});
    expect(textOf(msgs[0]!)).toBe("now=42");
  });

  it("merges multiple providers into one system message, order preserved", async () => {
    const msgs = await resolveContext([staticContext("first"), staticContext("second")], {});
    expect(msgs).toHaveLength(1);
    expect(textOf(msgs[0]!)).toBe("first\n\nsecond");
  });

  it("resolves to [] when there are no providers", async () => {
    expect(await resolveContext(undefined, {})).toEqual([]);
    expect(await resolveContext([], {})).toEqual([]);
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens([user("abcdefgh")])).toBe(2); // 8 chars / 4
  });
});

describe("truncateOldest", () => {
  const ctx = {
    maxTokens: 0,
    countTokens: (msgs: readonly Message[]) => msgs.length, // 1 "token" per message
    provider: mockProvider(),
    model: "m",
    engine: {},
  };

  it("drops oldest non-system messages but keeps system messages", async () => {
    const messages = [system("sys"), user("1"), assistant("2"), user("3")];
    const result = await truncateOldest().reduce([...messages], { ...ctx, maxTokens: 2 });
    // keeps system + the most recent message to fit 2
    expect(result.map((m) => m.role)).toEqual(["system", "user"]);
    expect(textOf(result[1]!)).toBe("3");
  });

  it("throws ContextWindowError when system messages alone exceed the budget", () => {
    const messages = [system("a"), system("b"), user("1")];
    // reduce() throws synchronously here (no async work needed).
    expect(() => truncateOldest().reduce([...messages], { ...ctx, maxTokens: 1 })).toThrow(
      ContextWindowError,
    );
  });
});

describe("summarizeOldest", () => {
  const baseCtx = {
    maxTokens: 100,
    countTokens: (msgs: readonly Message[]) => msgs.length,
    model: "m",
    engine: {},
  };

  it("replaces older messages with a single system summary via the provider", async () => {
    const provider = mockProvider({
      result: () => ({
        message: { role: "assistant", content: [{ type: "text", text: "SUMMARY" }] },
        toolCalls: [],
        finishReason: "stop",
        model: "m",
        raw: {},
      }),
    });
    const messages = [
      system("sys"),
      user("old-1"),
      assistant("old-2"),
      user("recent-1"),
      assistant("recent-2"),
      user("recent-3"),
      assistant("recent-4"),
    ];
    const result = await summarizeOldest({ keepRecent: 4 }).reduce([...messages], {
      ...baseCtx,
      provider,
    });
    // system + summary + 4 recent
    expect(result.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user", "assistant"]);
    expect(textOf(result[1]!)).toContain("SUMMARY");
    expect(textOf(result[4]!)).toBe("recent-3");
    expect(textOf(result[5]!)).toBe("recent-4");
  });

  it("throws ContextWindowError if the summarized result still overflows", async () => {
    const provider = mockProvider({
      result: () => ({
        message: { role: "assistant", content: [{ type: "text", text: "S" }] },
        toolCalls: [],
        finishReason: "stop",
        model: "m",
        raw: {},
      }),
    });
    const messages = [system("sys"), user("old"), user("r1"), user("r2"), user("r3"), user("r4")];
    // result = system + summary + 4 recent = 6 messages > maxTokens 3
    await expect(
      summarizeOldest({ keepRecent: 4 }).reduce([...messages], { ...baseCtx, maxTokens: 3, provider }),
    ).rejects.toBeInstanceOf(ContextWindowError);
  });
});
