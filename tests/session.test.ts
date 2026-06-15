import { describe, expect, it } from "bun:test";

import { user } from "../src/messages/index";
import {
  createSession,
  InMemorySessionStore,
  readResumeInfo,
  withResumeInfo,
} from "../src/session/index";

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

  it("treats expired entries as absent before CAS append", async () => {
    const store = new InMemorySessionStore();
    await store.appendIfVersion("s1", [user("old")], 0);
    await store.setExpiry("s1", 0);

    expect(await store.load("s1")).toBeUndefined();
    await expect(
      store.appendIfVersion("s1", [user("new")], 0),
    ).resolves.toEqual({});

    const state = await store.load("s1");
    expect(state?.messages.map((message) => message.content[0])).toEqual([
      { type: "text", text: "new" },
    ]);
    expect(state?.version).toBe(1);
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
    expect(history.map((m) => m.content[0])).toEqual([
      { type: "text", text: "earlier" },
    ]);
  });

  it("seeds history only when the store is empty for the id", async () => {
    const store = new InMemorySessionStore();
    await store.append("tab-1", [user("existing")]);
    const session = createSession({
      id: "tab-1",
      store,
      messages: [user("seed")],
    });
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
    const [history] = await Promise.all([
      session.messages(),
      session.append([user("new")]),
    ]);
    void history;
    const final = await session.messages();
    // seed must not be lost: both the seed and the appended message are present.
    expect(final.map((m) => m.content[0])).toEqual([
      { type: "text", text: "seed" },
      { type: "text", text: "new" },
    ]);
  });

  it("clear concurrent with first access leaves no stale seed", async () => {
    const session = createSession({
      id: "race-clear",
      messages: [user("seed")],
    });
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

  it("persists a tenant id when creating a new session", async () => {
    const store = new InMemorySessionStore();
    const session = createSession({
      id: "tenant-session",
      store,
      tenantId: "t1",
    });

    await session.append([user("hello")]);

    expect(session.tenantId).toBe("t1");
    expect((await store.load("tenant-session"))?.tenantId).toBe("t1");
  });

  it("attaches a tenant id to an existing global session on first use", async () => {
    const store = new InMemorySessionStore();
    await store.save({ id: "global-session", messages: [user("existing")] });
    const session = createSession({
      id: "global-session",
      store,
      tenantId: "t1",
    });

    await session.messages();

    expect((await store.load("global-session"))?.tenantId).toBe("t1");
  });

  it("rejects an existing session owned by a different tenant", async () => {
    const store = new InMemorySessionStore();
    await store.save({
      id: "owned-session",
      messages: [user("existing")],
      tenantId: "t1",
    });
    const session = createSession({
      id: "owned-session",
      store,
      tenantId: "t2",
    });

    await expect(session.messages()).rejects.toThrow(
      'session "owned-session" is owned by a different tenant',
    );
  });

  it("rejects concurrent conflicting tenant claims", async () => {
    const store = new InMemorySessionStore();
    const first = createSession({
      id: "tenant-race",
      store,
      tenantId: "t1",
      messages: [user("first")],
    });
    const second = createSession({
      id: "tenant-race",
      store,
      tenantId: "t2",
      messages: [user("second")],
    });

    const results = await Promise.allSettled([
      first.messages(),
      second.messages(),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as Error).message,
    ).toBe('session "tenant-race" is owned by a different tenant');
    const state = await store.load("tenant-race");
    expect(new Set(["t1", "t2"]).has(state?.tenantId ?? "")).toBe(true);
    expect(state?.messages).toHaveLength(1);
  });
});

describe("resume metadata", () => {
  it("preserves internal engine metadata when callers set user metadata", async () => {
    const store = new InMemorySessionStore();
    const resume = {
      schemaVersion: 2,
      agentName: "agent",
      lastActiveAt: new Date().toISOString(),
      lastRunStatus: "completed" as const,
    };
    await store.save({
      id: "meta",
      messages: [],
      metadata: withResumeInfo({ keep: true }, resume),
    });
    const session = createSession({ id: "meta", store });

    await session.setMetadata({ user: "value", "engine:resume": { bad: true } });

    expect(await session.getMetadata()).toMatchObject({
      keep: true,
      user: "value",
      "engine:resume": resume,
    });
  });

  it("does not lose appends from concurrent handles with the same seed", async () => {
    const store = new InMemorySessionStore();
    const first = createSession({
      id: "same-seed",
      store,
      messages: [user("seed")],
    });
    const second = createSession({
      id: "same-seed",
      store,
      messages: [user("seed")],
    });

    await Promise.all([
      first.append([user("first")]),
      second.append([user("second")]),
    ]);

    expect((await first.messages()).map((m) => m.content[0])).toEqual([
      { type: "text", text: "seed" },
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("reads v2 agent compatibility fields", () => {
    const metadata = withResumeInfo(undefined, {
      schemaVersion: 2,
      agentName: "agent",
      agentVersion: "1.2.3",
      toolNames: ["a", "b"],
      lastActiveAt: new Date().toISOString(),
      lastRunStatus: "completed",
    });

    expect(readResumeInfo(metadata)).toMatchObject({
      schemaVersion: 2,
      agentName: "agent",
      agentVersion: "1.2.3",
      toolNames: ["a", "b"],
    });
  });
});
