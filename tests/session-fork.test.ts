import { describe, expect, it } from "bun:test";

import { assistant, toolResult, user } from "../src/messages/index";
import type { Message } from "../src/messages/index";
import {
  createSession,
  forkSession,
  InMemorySessionStore,
  snapForkIndex,
} from "../src/session/index";

function toolCallMessage(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, arguments: {} }],
  };
}

describe("FORK-T1 session forking", () => {
  it("copies all messages by default and leaves the original independent (AC-8, FR-17)", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "src", store });
    await source.append([user("one"), assistant("two"), user("three")]);

    const fork = await source.fork();
    expect(fork.id).not.toBe("src");
    expect(await fork.messages()).toHaveLength(3);

    await fork.append([assistant("fork-only")]);
    expect(await fork.messages()).toHaveLength(4);
    // Original is untouched by appends to the fork.
    expect(await source.messages()).toHaveLength(3);

    await source.append([user("orig-only")]);
    expect(await source.messages()).toHaveLength(4);
    // Fork is untouched by appends to the original.
    expect(await fork.messages()).toHaveLength(4);
  });

  it("snaps the fork point down to a turn boundary (AC-9, FR-18)", () => {
    // index: 0 user, 1 assistant(tool_call), 2 tool result, 3 user
    const messages: Message[] = [
      user("q"),
      toolCallMessage("c1", "search"),
      toolResult("c1", "hit"),
      user("next"),
    ];
    // Cutting at index 2 would split the tool-call (1) from its result (2);
    // it must snap down to 1 (the boundary before the assistant tool-call turn).
    expect(snapForkIndex(messages, 2)).toBe(1);
    // Index 3 is past the whole tool turn → kept.
    expect(snapForkIndex(messages, 3)).toBe(3);
    // Bounds clamp.
    expect(snapForkIndex(messages, 0)).toBe(0);
    expect(snapForkIndex(messages, 99)).toBe(4);
  });

  it("forks at a snapped index without splitting a tool turn (AC-9)", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "turns", store });
    await source.append([
      user("q"),
      toolCallMessage("c1", "search"),
      toolResult("c1", "hit"),
      user("next"),
    ]);

    const fork = await source.fork({ atIndex: 2 });
    const messages = await fork.messages();
    // Snapped to 1: only the leading user message survives.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("inherits the source tenantId (AC-11, FR-20)", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "owned", store, tenantId: "t1" });
    await source.append([user("hello")]);

    const fork = await source.fork({ id: "owned-fork" });
    expect(fork.tenantId).toBe("t1");
    const state = await store.load("owned-fork");
    expect(state?.tenantId).toBe("t1");
  });

  it("copies metadata by default and can drop or override it (FR-16)", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({
      id: "meta",
      store,
      metadata: { topic: "weather" },
    });
    await source.append([user("hi")]);

    const copied = await source.fork();
    expect(await copied.getMetadata()).toEqual({ topic: "weather" });

    const dropped = await source.fork({ metadata: false });
    expect(await dropped.getMetadata()).toBeUndefined();

    const overridden = await source.fork({ metadata: { topic: "sports" } });
    expect(await overridden.getMetadata()).toEqual({ topic: "sports" });
  });

  it("forks an empty/absent session into a new empty session", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "empty", store });
    const fork = await source.fork();
    expect(await fork.messages()).toEqual([]);
  });

  it("forkSession works as a free function over the store contract (AC-10, FR-19)", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "free", store });
    await source.append([user("a"), assistant("b")]);

    const fork = await forkSession(source, { id: "free-fork", atIndex: 1 });
    expect(await fork.messages()).toHaveLength(1);
    // Original durably present and unchanged.
    const original = await store.load("free");
    expect(original?.messages).toHaveLength(2);
  });

  it("rejects an explicit fork target id that already exists", async () => {
    const store = new InMemorySessionStore();
    const source = createSession({ id: "source", store });
    const target = createSession({ id: "target", store });
    await source.append([user("source")]);
    await target.append([user("existing")]);

    await expect(source.fork({ id: "target" })).rejects.toThrow(
      "fork target session already exists: target",
    );
    expect(await target.messages()).toEqual([user("existing")]);
  });
});
