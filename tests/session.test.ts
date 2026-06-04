import { describe, expect, it } from "bun:test";

import { user } from "../src/messages/index";
import { createSession, InMemorySessionStore } from "../src/session/index";

describe("InMemorySessionStore", () => {
  it("load returns undefined for an unknown id", async () => {
    const store = new InMemorySessionStore();
    expect(await store.load("nope")).toBeUndefined();
  });

  it("append creates then extends history in order", async () => {
    const store = new InMemorySessionStore();
    await store.append("s1", [user("a")]);
    await store.append("s1", [user("b")]);
    const state = await store.load("s1");
    expect(state?.messages.map((m) => m.content[0])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("save replaces the full state and delete removes it", async () => {
    const store = new InMemorySessionStore();
    await store.append("s1", [user("a")]);
    await store.save({ id: "s1", messages: [user("z")], metadata: { k: 1 } });
    const state = await store.load("s1");
    expect(state?.messages).toHaveLength(1);
    expect(state?.metadata).toEqual({ k: 1 });
    await store.delete("s1");
    expect(await store.load("s1")).toBeUndefined();
  });

  it("does not expose internal arrays by reference", async () => {
    const store = new InMemorySessionStore();
    await store.append("s1", [user("a")]);
    const first = await store.load("s1");
    first?.messages.length; // read-only snapshot
    await store.append("s1", [user("b")]);
    expect(first?.messages).toHaveLength(1); // earlier snapshot unchanged
  });
});

describe("createSession", () => {
  it("generates an id when none is provided", () => {
    const session = createSession();
    expect(session.id).toMatch(/^session_/);
  });

  it("resumes existing history by id from a shared store", async () => {
    const store = new InMemorySessionStore();
    await store.append("tab-1", [user("earlier")]);
    const session = createSession({ id: "tab-1", store });
    const history = await session.messages();
    expect(history.map((m) => m.content[0])).toEqual([{ type: "text", text: "earlier" }]);
  });

  it("seeds history only when the store is empty for the id", async () => {
    const store = new InMemorySessionStore();
    await store.append("tab-1", [user("existing")]);
    const session = createSession({ id: "tab-1", store, messages: [user("seed")] });
    // store already had history → seed is NOT applied
    expect((await session.messages()).map((m) => m.content[0])).toEqual([
      { type: "text", text: "existing" },
    ]);
  });

  it("applies the seed when the store has no history", async () => {
    const session = createSession({ id: "fresh", messages: [user("seed")] });
    expect((await session.messages()).map((m) => m.content[0])).toEqual([
      { type: "text", text: "seed" },
    ]);
  });

  it("seeds exactly once under concurrent first access", async () => {
    const session = createSession({ id: "race", messages: [user("seed")] });
    // Fire messages() and append() concurrently on a fresh session.
    const [history] = await Promise.all([session.messages(), session.append([user("new")])]);
    void history;
    const final = await session.messages();
    // seed must not be lost: both the seed and the appended message are present.
    expect(final.map((m) => m.content[0])).toEqual([
      { type: "text", text: "seed" },
      { type: "text", text: "new" },
    ]);
  });

  it("clear concurrent with first access leaves no stale seed", async () => {
    const session = createSession({ id: "race-clear", messages: [user("seed")] });
    // messages() kicks off seeding; clear() runs concurrently.
    await Promise.all([session.messages(), session.clear()]);
    // The in-flight seed must not survive the clear.
    expect(await session.messages()).toHaveLength(0);
  });

  it("append persists and clear wipes (and prevents re-seeding)", async () => {
    const session = createSession({ id: "s", messages: [user("seed")] });
    await session.append([user("more")]);
    expect(await session.messages()).toHaveLength(2);
    await session.clear();
    expect(await session.messages()).toHaveLength(0);
  });
});
