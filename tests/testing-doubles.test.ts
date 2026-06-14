import { describe, expect, it } from "bun:test";

import {
  InMemorySessionStore,
  inMemorySessionStore,
  scriptedProvider,
  textResult,
  toolCallResult,
} from "../src/testing/index";
import { user } from "../src/messages/index";

describe("textResult / toolCallResult builders", () => {
  it("builds a buffered text result with optional usage", () => {
    const r = textResult("hello", {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    expect(r.finishReason).toBe("stop");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  it("omits usage when not supplied", () => {
    expect(textResult("hi").usage).toBeUndefined();
  });

  it("builds a tool-call result mirrored as a message part", () => {
    const r = toolCallResult([
      { id: "c1", name: "search", arguments: { q: "x" } },
    ]);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.message.content).toEqual([
      { type: "tool_call", id: "c1", name: "search", arguments: { q: "x" } },
    ]);
  });
});

describe("scriptedProvider", () => {
  it("returns each result in turn, then repeats the last", async () => {
    const provider = scriptedProvider([
      textResult("first"),
      textResult("second"),
    ]);
    const out = async () =>
      (await provider.complete({ messages: [user("go")] })).message.content;
    expect(await out()).toEqual([{ type: "text", text: "first" }]);
    expect(await out()).toEqual([{ type: "text", text: "second" }]);
    expect(await out()).toEqual([{ type: "text", text: "second" }]);
  });

  it("forwards mockProvider options (e.g. name)", () => {
    expect(scriptedProvider([textResult("x")], { name: "scripted" }).name).toBe(
      "scripted",
    );
  });
});

describe("in-memory session store double", () => {
  it("inMemorySessionStore() returns a fresh InMemorySessionStore", async () => {
    const store = inMemorySessionStore();
    expect(store).toBeInstanceOf(InMemorySessionStore);

    await store.append("s1", [user("hi")]);
    const state = await store.load("s1");
    expect(state?.messages).toHaveLength(1);
  });
});
