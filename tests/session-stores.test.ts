import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, raw, sql } from "@infinityi/forge/data";
import type { DatabaseSchema } from "@infinityi/forge/data";
import { createSqliteDialect, createSqliteDriver } from "@infinityi/forge/data/dialects/sqlite";

import { assistant, user } from "../src/messages/index";
import { createSession, InMemorySessionStore } from "../src/session/index";
import type { SessionState, SessionStore } from "../src/session/index";
import {
  FilesystemJsonlSessionStore,
  ForgeDataSessionStore,
  RedisSessionStore,
  SUMMARY_METADATA_KEY,
  SESSION_STORE_SCHEMA_VERSION,
  createPostgresSessionStore,
  createSqliteSessionStore,
  migrateSessionStore,
  summarizingCompactor,
  withSessionStoreHooks,
} from "../src/session-stores/index";
import type { RedisSessionStoreClient, RedisSessionStoreTransaction, SessionArchiveRecord, SessionStoreCodec } from "../src/session-stores/index";
import { mockProvider, runSessionStoreConformance } from "../src/testing/index";

interface StoreFixture {
  readonly store: SessionStore;
  readonly cleanup?: () => Promise<void>;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engine-session-store-"));
  tempDirs.push(dir);
  return dir;
}

function messageTexts(state: SessionState | undefined): string[] | undefined {
  return state?.messages.map((message) => {
    const part = message.content[0];
    return part?.type === "text" ? part.text : "";
  });
}

async function closeStore(store: SessionStore): Promise<void> {
  const close = (store as { close?: () => Promise<void> }).close;
  if (close !== undefined) await close.call(store);
}

function runSessionStoreContract(name: string, createFixture: () => Promise<StoreFixture>): void {
  async function withStore<T>(run: (store: SessionStore) => Promise<T>): Promise<T> {
    const fixture = await createFixture();
    try {
      return await run(fixture.store);
    } finally {
      await fixture.cleanup?.();
      await closeStore(fixture.store);
    }
  }

  describe(name, () => {
    it("load returns undefined for an unknown id", async () => {
      await withStore(async (store) => {
        expect(await store.load("missing")).toBeUndefined();
      });
    });

    it("append creates then extends history in order", async () => {
      await withStore(async (store) => {
        await store.append("s1", [user("a")]);
        await store.append("s1", [user("b")]);
        expect(messageTexts(await store.load("s1"))).toEqual(["a", "b"]);
      });
    });

    it("empty append is a no-op", async () => {
      await withStore(async (store) => {
        await store.append("s1", []);
        expect(await store.load("s1")).toBeUndefined();
      });
    });

    it("save replaces full state and delete removes it", async () => {
      await withStore(async (store) => {
        await store.append("s1", [user("a")]);
        await store.save({ id: "s1", messages: [user("z")], metadata: { owner: "test" } });
        const state = await store.load("s1");
        expect(messageTexts(state)).toEqual(["z"]);
        expect(state?.metadata).toEqual({ owner: "test" });

        await store.save({ id: "empty", messages: [], metadata: { saved: true } });
        expect(messageTexts(await store.load("empty"))).toEqual([]);
        expect((await store.load("empty"))?.metadata).toEqual({ saved: true });

        await store.delete("s1");
        await store.delete("s1");
        expect(await store.load("s1")).toBeUndefined();
      });
    });

    it("does not expose loaded message arrays by reference", async () => {
      await withStore(async (store) => {
        await store.append("s1", [user("a")]);
        const first = await store.load("s1");
        await store.append("s1", [user("b")]);
        expect(first?.messages).toHaveLength(1);
        expect(messageTexts(await store.load("s1"))).toEqual(["a", "b"]);
      });
    });

    it("preserves all messages under concurrent append", async () => {
      await withStore(async (store) => {
        await Promise.all(Array.from({ length: 10 }, (_, index) => store.append("race", [user(String(index))])));
        expect(messageTexts(await store.load("race"))?.toSorted()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
      });
    });

    it("works through createSession", async () => {
      await withStore(async (store) => {
        const session = createSession({ id: "session", store, messages: [user("seed")] });
        await session.append([user("tail")]);
        expect(messageTexts(await store.load("session"))).toEqual(["seed", "tail"]);
      });
    });
  });
}

class FakeRedisTransaction implements RedisSessionStoreTransaction {
  private readonly operations: Array<() => void> = [];

  constructor(private readonly client: FakeRedisClient) {}

  del(...keys: string[]): RedisSessionStoreTransaction {
    this.operations.push(() => this.client.delSync(...keys));
    return this;
  }

  set(key: string, value: string): RedisSessionStoreTransaction {
    this.operations.push(() => this.client.setSync(key, value));
    return this;
  }

  rPush(key: string, ...values: string[]): RedisSessionStoreTransaction {
    this.operations.push(() => this.client.rPushSync(key, ...values));
    return this;
  }

  exec(): void {
    for (const operation of this.operations) operation();
  }
}

class FakeRedisClient implements RedisSessionStoreClient {
  private readonly strings = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
  readonly expiries: Array<{ key: string; ttlMs: number }> = [];

  get(key: string): string | undefined {
    return this.strings.get(key);
  }

  set(key: string, value: string): void {
    this.setSync(key, value);
  }

  del(...keys: string[]): void {
    this.delSync(...keys);
  }

  lRange(key: string, start: number, stop: number): string[] {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  rPush(key: string, ...values: string[]): number {
    return this.rPushSync(key, ...values);
  }

  pExpire(key: string, ttlMs: number): void {
    this.expiries.push({ key, ttlMs });
  }

  scan(_cursor: string, options?: { readonly MATCH?: string; readonly COUNT?: number }): { cursor: string; keys: string[] } {
    const pattern = options?.MATCH === undefined
      ? undefined
      : new RegExp(`^${options.MATCH.split("*").map(escapeRegExp).join(".*")}$`);
    const keys = [...this.strings.keys(), ...this.lists.keys()].filter((key) => pattern === undefined || pattern.test(key));
    return { cursor: "0", keys };
  }

  multi(): RedisSessionStoreTransaction {
    return new FakeRedisTransaction(this);
  }

  setSync(key: string, value: string): void {
    this.strings.set(key, value);
  }

  delSync(...keys: string[]): void {
    for (const key of keys) {
      this.strings.delete(key);
      this.lists.delete(key);
    }
  }

  rPushSync(key: string, ...values: string[]): number {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

runSessionStoreConformance("InMemorySessionStore", {
  testApi: { describe, expect, it },
  makeStore: () => new InMemorySessionStore(),
});

runSessionStoreConformance("ForgeDataSessionStore over injected SQLite", {
  testApi: { describe, expect, it },
  makeStore: async () => {
    const db = createDb<DatabaseSchema>({
      dialect: createSqliteDialect(),
      driver: createSqliteDriver(),
    });
    const store = new ForgeDataSessionStore({ db, closeDbOnClose: true });
    await store.migrate();
    return store;
  },
});

runSessionStoreConformance("createSqliteSessionStore", {
  testApi: { describe, expect, it },
  makeStore: async () => createSqliteSessionStore({ filename: ":memory:", migrate: true }),
});

runSessionStoreConformance("FilesystemJsonlSessionStore", {
  testApi: { describe, expect, it },
  makeStore: async () => {
    const store = new FilesystemJsonlSessionStore({ directory: await tempDirectory() });
    await store.migrate();
    return store;
  },
});

runSessionStoreConformance("RedisSessionStore", {
  testApi: { describe, expect, it },
  makeStore: async () => {
    const store = new RedisSessionStore({ client: new FakeRedisClient() });
    await store.migrate();
    return store;
  },
});

runSessionStoreContract("SQLite session store", async () => ({
  store: await createSqliteSessionStore({ filename: ":memory:", migrate: true }),
}));

runSessionStoreContract("filesystem JSONL session store", async () => {
  const store = new FilesystemJsonlSessionStore({ directory: await tempDirectory() });
  await store.migrate();
  return { store };
});

runSessionStoreContract("Redis session store", async () => {
  const store = new RedisSessionStore({ client: new FakeRedisClient() });
  await store.migrate();
  return { store };
});

describe("ForgeDataSessionStore", () => {
  it("uses an injected Forge sqlite Db", async () => {
    const db = createDb<DatabaseSchema>({
      dialect: createSqliteDialect(),
      driver: createSqliteDriver(),
    });
    const store = new ForgeDataSessionStore({ db });
    try {
      await migrateSessionStore(store);
      await store.append("s1", [user("hi")]);
      expect(messageTexts(await store.load("s1"))).toEqual(["hi"]);
    } finally {
      await db.shutdown();
    }
  });

  it("runs idempotent migrations and records schema version", async () => {
    const store = await createSqliteSessionStore({ filename: ":memory:", migrate: true });
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toBe(SESSION_STORE_SCHEMA_VERSION);
    } finally {
      await store.close();
    }
  });

  it("creates a PostgreSQL store from a structural client", async () => {
    let ended = false;
    const client = {
      query: async () => ({ rows: [], rowCount: 0 }),
      end: async () => {
        ended = true;
      },
    };
    const store = await createPostgresSessionStore({ client, closeOnShutdown: false });
    expect(store).toBeInstanceOf(ForgeDataSessionStore);
    await store.close();
    expect(ended).toBe(false);
  });

  it("purges idle SQL sessions by updated_at", async () => {
    const db = createDb<DatabaseSchema>({
      dialect: createSqliteDialect(),
      driver: createSqliteDriver(),
    });
    const store = new ForgeDataSessionStore({ db, closeDbOnClose: true });
    try {
      await store.migrate();
      await store.append("stale", [user("old")]);
      await store.append("fresh", [user("new")]);
      await db.raw(sql`
        update ${raw('"engine_session_sessions"')}
        set updated_at = ${new Date(Date.now() - 10 * 86_400_000).toISOString()}
        where id = ${"stale"}
      `).execute();

      const purged = await store.purgeExpired({ maxIdleMs: 86_400_000 });
      expect(purged).toEqual(["stale"]);
      expect(await store.load("stale")).toBeUndefined();
      expect(messageTexts(await store.load("fresh"))).toEqual(["new"]);
    } finally {
      await store.close();
    }
  });
});

describe("RedisSessionStore v2 capabilities", () => {
  it("applies PEXPIRE to all per-session keys", async () => {
    const client = new FakeRedisClient();
    const store = new RedisSessionStore({ client });
    await store.setExpiry("ttl", 1000);
    expect(client.expiries.map((entry) => entry.ttlMs)).toEqual([1000, 1000, 1000]);
    expect(client.expiries.map((entry) => entry.key).toSorted()).toEqual([
      "engine:sessions:dHRs:exists",
      "engine:sessions:dHRs:messages",
      "engine:sessions:dHRs:metadata",
    ]);
  });
});

describe("FilesystemJsonlSessionStore", () => {
  it("persists across store instances and compacts logs", async () => {
    const directory = await tempDirectory();
    const first = new FilesystemJsonlSessionStore({ directory });
    await first.migrate();
    await first.append("s1", [user("a")]);
    await first.append("s1", [user("b")]);

    const second = new FilesystemJsonlSessionStore({ directory });
    expect(messageTexts(await second.load("s1"))).toEqual(["a", "b"]);
    await second.compact("s1");

    const files = (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const compacted = await readFile(join(directory, files[0]!), "utf8");
    expect(compacted.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("round-trips through a custom codec without plaintext at rest", async () => {
    const codec: SessionStoreCodec = {
      encodeMessage: (message) => Buffer.from(JSON.stringify(message), "utf8").toString("base64url"),
      decodeMessage: (payload) => JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReturnType<typeof user>,
      encodeMetadata: (metadata) => metadata === undefined ? undefined : Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
      decodeMetadata: (payload) => payload === undefined ? undefined : JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
    };
    const directory = await tempDirectory();
    const store = new FilesystemJsonlSessionStore({ directory, codec });
    await store.migrate();
    await store.save({ id: "s1", messages: [user("secret")], metadata: { owner: "private" } });

    const files = (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"));
    const raw = await readFile(join(directory, files[0]!), "utf8");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("private");
    expect(messageTexts(await store.load("s1"))).toEqual(["secret"]);
    expect((await store.load("s1"))?.metadata).toEqual({ owner: "private" });
  });
});

describe("withSessionStoreHooks", () => {
  it("archives and compacts after writes without recursion", async () => {
    const archived: SessionArchiveRecord[] = [];
    const store = withSessionStoreHooks(new InMemorySessionStore(), {
      compactor: {
        shouldCompact: (state) => state.messages.length > 1,
        compact: (state) => ({
          state: { id: state.id, messages: state.messages.slice(-1), metadata: state.metadata },
          archive: { messages: state.messages.slice(0, -1), reason: "keep-last" },
        }),
      },
      archiver: {
        archive: (record) => {
          archived.push(record);
        },
      },
    });

    await store.append("s1", [user("old")]);
    await store.append("s1", [user("new")]);

    expect(messageTexts(await store.load("s1"))).toEqual(["new"]);
    expect(archived).toHaveLength(1);
    expect(messageTexts({ id: "archive", messages: archived[0]!.messages ?? [] })).toEqual(["old"]);
  });

  it("summarizingCompactor persists one pinned summary and reports AppendResult", async () => {
    let providerCalls = 0;
    const archived: SessionArchiveRecord[] = [];
    const provider = mockProvider({
      result: () => {
        providerCalls += 1;
        return {
          message: { role: "assistant", content: [{ type: "text", text: "SUMMARY" }] },
          toolCalls: [],
          finishReason: "stop",
          model: "m",
          raw: {},
        };
      },
    });
    const store = withSessionStoreHooks(new InMemorySessionStore(), {
      compactor: summarizingCompactor({
        provider,
        model: "m",
        keepRecentTurns: 1,
        shouldCompactAt: { messages: 4 },
      }),
      archiver: {
        archive: (record) => {
          archived.push(record);
        },
      },
    });

    const result = await store.append("s1", [
      user("old-1"),
      assistant("old-2"),
      user("old-3"),
      assistant("old-4"),
      user("recent"),
    ]);

    expect(result.compacted).toBe(true);
    expect(result.removed).toBeGreaterThan(0);
    const state = await store.load("s1");
    expect(state?.messages).toHaveLength(2);
    expect(state?.messages[0]?.role).toBe("system");
    expect(state?.messages[0]?.metadata).toMatchObject({ pinned: true, [SUMMARY_METADATA_KEY]: true });
    expect(messageTexts(state)).toEqual(["Summary of earlier conversation:\nSUMMARY", "recent"]);
    expect(archived[0]?.messages).toHaveLength(4);

    await store.append("s1", [assistant("final")]);
    expect(providerCalls).toBe(1);
    expect((await store.load("s1"))?.messages.filter((message) => message.metadata?.[SUMMARY_METADATA_KEY] === true)).toHaveLength(1);
  });
});
