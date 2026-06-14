import type {
  describe as bunDescribe,
  expect as bunExpect,
  it as bunIt,
} from "bun:test";

import { user } from "../messages/index";
import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import {
  isCloseableSessionStore,
  isExpiringSessionStore,
} from "../session-stores/versioning";

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
  readonly makeStore: () =>
    | SessionStore
    | SessionStoreFixture
    | Promise<SessionStore | SessionStoreFixture>;
}

function getTestApi(): SessionStoreConformanceTestApi {
  const globals = globalThis as typeof globalThis &
    Partial<SessionStoreConformanceTestApi>;
  if (
    typeof globals.describe === "function" &&
    typeof globals.expect === "function" &&
    typeof globals.it === "function"
  ) {
    return {
      describe: globals.describe,
      expect: globals.expect,
      it: globals.it,
    };
  }
  try {
    const requireFn = (0, eval)("require") as
      | ((id: string) => Partial<SessionStoreConformanceTestApi>)
      | undefined;
    const api =
      typeof requireFn === "function" ? requireFn("bun:test") : undefined;
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
  throw new Error(
    "runSessionStoreConformance requires Bun's test runner; call it from a Bun test file.",
  );
}

function textOf(message: Message): string {
  const part = message.content[0];
  return part?.type === "text" ? part.text : "";
}

function messageTexts(state: SessionState | undefined): string[] | undefined {
  return state?.messages.map(textOf);
}

function asFixture(
  value: SessionStore | SessionStoreFixture,
): SessionStoreFixture {
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

  async function withStore<T>(
    run: (store: SessionStore) => Promise<T>,
  ): Promise<T> {
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
        expect((await store.load("metadata-only"))?.metadata).toEqual({
          created: true,
        });

        await store.save({
          id: "s1",
          messages: [user("z")],
          metadata: { replaced: true },
        });
        expect(messageTexts(await store.load("s1"))).toEqual(["z"]);
        expect((await store.load("s1"))?.metadata).toEqual({ replaced: true });
        await store.delete("s1");
        expect(await store.load("s1")).toBeUndefined();
      });
    });

    it("lists sessions with pagination, ordering, prefix filtering, and metadata summaries", async () => {
      await withStore(async (store) => {
        await store.save({
          id: "app/a",
          messages: [user("a")],
          metadata: { tag: "a" },
        });
        await delayTick();
        await store.save({
          id: "app/b",
          messages: [user("b")],
          metadata: { tag: "b" },
        });
        await delayTick();
        await store.save({
          id: "other/c",
          messages: [user("c")],
          metadata: { tag: "c" },
        });

        const byId = await store.list({
          prefix: "app/",
          order: "id",
          limit: 1,
        });
        expect(byId.sessions.map((session) => session.id)).toEqual(["app/a"]);
        expect(byId.cursor).toBeDefined();
        const nextById = await store.list({ cursor: byId.cursor });
        expect(nextById.sessions.map((session) => session.id)).toEqual([
          "app/b",
        ]);
        expect(nextById.sessions[0]?.messageCount).toBe(1);

        const recent = await store.list({ order: "recent", limit: 2 });
        expect(recent.sessions).toHaveLength(2);
        expect(new Set(recent.sessions.map((session) => session.id)).size).toBe(
          2,
        );
      });
    });

    it("returns immutable snapshots", async () => {
      await withStore(async (store) => {
        await store.append("snap", [user("first")]);
        const first = await store.load("snap");
        await store.append("snap", [user("second")]);
        expect(messageTexts(first)).toEqual(["first"]);
        expect(messageTexts(await store.load("snap"))).toEqual([
          "first",
          "second",
        ]);
      });
    });

    it("preserves reserved version and tenant fields", async () => {
      await withStore(async (store) => {
        await store.save({
          id: "tenant/a",
          messages: [user("a")],
          version: 7,
          tenantId: "t1",
        });
        await store.save({ id: "tenant/a", messages: [user("replacement")] });
        await store.save({
          id: "tenant/b",
          messages: [user("b")],
          tenantId: "t2",
        });
        await store.save({
          id: "tenant/c",
          messages: [user("c")],
          tenantId: "t1",
        });
        await store.append("tenant/a", [user("tail")]);

        const loaded = await store.load("tenant/a");
        expect(loaded?.version).toBe(7);
        expect(loaded?.tenantId).toBe("t1");
        expect(messageTexts(loaded)).toEqual(["replacement", "tail"]);

        const tenantPage = await store.list({
          tenantId: "t1",
          order: "id",
          limit: 1,
        });
        expect(tenantPage.sessions.map((session) => session.id)).toEqual([
          "tenant/a",
        ]);
        expect(tenantPage.cursor).toBeDefined();
        expect(tenantPage.sessions[0]?.version).toBe(7);
        expect(tenantPage.sessions[0]?.tenantId).toBe("t1");

        const nextTenantPage = await store.list({
          tenantId: "t1",
          cursor: tenantPage.cursor,
        });
        expect(nextTenantPage.sessions.map((session) => session.id)).toEqual([
          "tenant/c",
        ]);

        // The cursor carries tenantId forward, so a caller paging with only
        // the cursor must observe the same tenant-scoped page.
        const cursorOnlyPage = await store.list({ cursor: tenantPage.cursor });
        expect(cursorOnlyPage.sessions.map((session) => session.id)).toEqual([
          "tenant/c",
        ]);

        // A conflicting tenant option still rejects the cursor.
        let cursorError: unknown;
        try {
          await store.list({ tenantId: "t2", cursor: tenantPage.cursor });
        } catch (error) {
          cursorError = error;
        }
        expect(cursorError).toBeInstanceOf(Error);
        expect((cursorError as Error).message).toBe("invalid list cursor");
      });
    });

    it("accepts a v1 cursor and falls back to unfiltered listing", async () => {
      await withStore(async (store) => {
        await store.save({ id: "v1/a", messages: [user("a")], tenantId: "t1" });
        await store.save({ id: "v1/b", messages: [user("b")], tenantId: "t2" });
        const v1Cursor = Buffer.from(
          JSON.stringify({ version: 1, prefix: "v1/", order: "id", offset: 1 }),
          "utf8",
        ).toString("base64url");

        const page = await store.list({ cursor: v1Cursor });
        expect(page.sessions.map((session) => session.id)).toEqual(["v1/b"]);
      });
    });

    it("claims tenant ownership once", async () => {
      await withStore(async (store) => {
        await expect(
          store.claimTenant({
            id: "claim/session",
            tenantId: "t1",
            messages: [user("seed")],
            metadata: { created: true },
          }),
        ).resolves.toBe(true);

        const claimed = await store.load("claim/session");
        expect(claimed?.tenantId).toBe("t1");
        expect(claimed?.metadata).toEqual({ created: true });
        expect(messageTexts(claimed)).toEqual(["seed"]);

        await expect(
          store.claimTenant({
            id: "claim/session",
            tenantId: "t1",
            messages: [user("ignored")],
            metadata: { ignored: true },
          }),
        ).resolves.toBe(false);
        expect(messageTexts(await store.load("claim/session"))).toEqual([
          "seed",
        ]);

        await expect(
          store.claimTenant({ id: "claim/session", tenantId: "t2" }),
        ).rejects.toThrow(
          'session "claim/session" is owned by a different tenant',
        );

        await store.save({ id: "claim/global-empty", messages: [] });
        await expect(
          store.claimTenant({
            id: "claim/global-empty",
            tenantId: "t1",
            messages: [user("attached")],
          }),
        ).resolves.toBe(true);
        const attached = await store.load("claim/global-empty");
        expect(attached?.tenantId).toBe("t1");
        expect(messageTexts(attached)).toEqual(["attached"]);
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
