import type {
  describe as bunDescribe,
  expect as bunExpect,
  it as bunIt,
} from "bun:test";

import { user } from "../messages/index";
import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import { isCloseableSessionStore, isExpiringSessionStore } from "../session-stores/versioning";

export interface SessionStoreConformanceTestApi {
  readonly describe: typeof bunDescribe;
  readonly expect: typeof bunExpect;
  readonly it: typeof bunIt;
}

export interface SessionStoreFixture {
  readonly store: SessionStore;
  readonly cleanup?: () => Promise<void> | void;
}

export interface SessionStoreConformanceOptions {
  readonly testApi?: SessionStoreConformanceTestApi;
  readonly makeStore: () => SessionStore | SessionStoreFixture | Promise<SessionStore | SessionStoreFixture>;
}

function getTestApi(): SessionStoreConformanceTestApi {
  const globals = globalThis as typeof globalThis & Partial<SessionStoreConformanceTestApi>;
  if (
    typeof globals.describe === "function" &&
    typeof globals.expect === "function" &&
    typeof globals.it === "function"
  ) {
    return { describe: globals.describe, expect: globals.expect, it: globals.it };
  }
  try {
    const requireFn = (0, eval)("require") as
      | ((id: string) => Partial<SessionStoreConformanceTestApi>)
      | undefined;
    const api = typeof requireFn === "function" ? requireFn("bun:test") : undefined;
    if (
      typeof api?.describe === "function" &&
      typeof api.expect === "function" &&
      typeof api.it === "function"
    ) {
      return { describe: api.describe, expect: api.expect, it: api.it };
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("runSessionStoreConformance requires Bun's test runner; call it from a Bun test file.");
}

function textOf(message: Message): string {
  const part = message.content[0];
  return part?.type === "text" ? part.text : "";
}

function messageTexts(state: SessionState | undefined): string[] | undefined {
  return state?.messages.map(textOf);
}

function asFixture(value: SessionStore | SessionStoreFixture): SessionStoreFixture {
  return "store" in value ? value : { store: value };
}

async function delayTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

export function runSessionStoreConformance(
  name: string,
  options: SessionStoreConformanceOptions,
): void {
  const { describe, expect, it } = options.testApi ?? getTestApi();

  async function withStore<T>(run: (store: SessionStore) => Promise<T>): Promise<T> {
    const fixture = asFixture(await options.makeStore());
    try {
      return await run(fixture.store);
    } finally {
      await fixture.cleanup?.();
      if (isCloseableSessionStore(fixture.store)) await fixture.store.close();
    }
  }

  describe(`session store conformance - ${name}`, () => {
    it("supports v2 append results, setMetadata, save, load, and delete", async () => {
      await withStore(async (store) => {
        expect(await store.append("s1", [user("a")])).toEqual({});
        await store.setMetadata("s1", { owner: "host" });
        expect(messageTexts(await store.load("s1"))).toEqual(["a"]);
        expect((await store.load("s1"))?.metadata).toEqual({ owner: "host" });

        await store.setMetadata("metadata-only", { created: true });
        expect(messageTexts(await store.load("metadata-only"))).toEqual([]);
        expect((await store.load("metadata-only"))?.metadata).toEqual({ created: true });

        await store.save({ id: "s1", messages: [user("z")], metadata: { replaced: true } });
        expect(messageTexts(await store.load("s1"))).toEqual(["z"]);
        expect((await store.load("s1"))?.metadata).toEqual({ replaced: true });
        await store.delete("s1");
        expect(await store.load("s1")).toBeUndefined();
      });
    });

    it("lists sessions with pagination, ordering, prefix filtering, and metadata summaries", async () => {
      await withStore(async (store) => {
        await store.save({ id: "app/a", messages: [user("a")], metadata: { tag: "a" } });
        await delayTick();
        await store.save({ id: "app/b", messages: [user("b")], metadata: { tag: "b" } });
        await delayTick();
        await store.save({ id: "other/c", messages: [user("c")], metadata: { tag: "c" } });

        const byId = await store.list({ prefix: "app/", order: "id", limit: 1 });
        expect(byId.sessions.map((session) => session.id)).toEqual(["app/a"]);
        expect(byId.cursor).toBeDefined();
        const nextById = await store.list({ cursor: byId.cursor });
        expect(nextById.sessions.map((session) => session.id)).toEqual(["app/b"]);
        expect(nextById.sessions[0]?.messageCount).toBe(1);

        const recent = await store.list({ order: "recent", limit: 2 });
        expect(recent.sessions).toHaveLength(2);
        expect(new Set(recent.sessions.map((session) => session.id)).size).toBe(2);
      });
    });

    it("returns immutable snapshots", async () => {
      await withStore(async (store) => {
        await store.append("snap", [user("first")]);
        const first = await store.load("snap");
        await store.append("snap", [user("second")]);
        expect(messageTexts(first)).toEqual(["first"]);
        expect(messageTexts(await store.load("snap"))).toEqual(["first", "second"]);
      });
    });

    it("exposes opt-in expiry without background deletion", async () => {
      await withStore(async (store) => {
        if (!isExpiringSessionStore(store)) return;
        const events: string[] = [];
        await store.append("expire-me", [user("old")]);
        await store.setExpiry("expire-me", 0);
        const purged = await store.purgeExpired({
          onEvent: (event) => events.push(`${event.sessionId}:${event.reason}`),
        });
        for (const id of purged) expect(id).toBe("expire-me");
        expect(events.length).toBe(purged.length);
      });
    });
  });
}
