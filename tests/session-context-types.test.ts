import { describe, expect, it } from "bun:test";

import {
  type ContextItem,
  type ContextProvider,
  type ContextResolveContext,
  type ContextStrategy,
  type ContextStrategyContext,
  type ContextWindowOptions,
  dynamicContext,
  staticContext,
} from "../src/context/index";
import type { Message } from "../src/messages/index";
import { user } from "../src/messages/index";
import type {
  AppendResult,
  CreateSessionOptions,
  Session,
  SessionListPage,
  SessionState,
  SessionStore,
} from "../src/session/index";
import { createSession } from "../src/session/index";
import { mockProvider } from "../src/testing/index";

function assertSessionAndContextTypes(): void {
  class DurableStore implements SessionStore {
    async load(_id: string): Promise<SessionState | undefined> {
      return undefined;
    }

    async append(
      _id: string,
      _messages: readonly Message[],
    ): Promise<AppendResult> {
      return {};
    }

    async setMetadata(
      _id: string,
      _metadata: Record<string, unknown>,
    ): Promise<void> {}

    async list(): Promise<SessionListPage> {
      return { sessions: [] };
    }

    async save(_state: SessionState): Promise<void> {}

    async claimTenant(): Promise<boolean> {
      return true;
    }

    async delete(_id: string): Promise<void> {}
  }

  const store: SessionStore = new DurableStore();
  const state: SessionState = {
    id: "s1",
    messages: [user("hello")],
    metadata: { owner: "terminal" },
  };
  void state;

  const opts: CreateSessionOptions = {
    id: "s1",
    store,
    messages: [user("seed")],
    metadata: { tab: 1 },
  };
  const session: Session = createSession(opts);
  const id: string = session.id;
  const metadata: Readonly<Record<string, unknown>> | undefined =
    session.metadata;
  void [id, metadata];

  const syncContext: ContextProvider = {
    name: "sync",
    resolve: () => [{ title: "Facts", content: { cwd: "." } }],
  };
  const asyncContext: ContextProvider = {
    name: "async",
    resolve: async (ctx) => {
      const signal: AbortSignal | undefined = ctx.signal;
      void signal;
      return [{ content: "ready" }];
    },
  };
  const staticProvider: ContextProvider = staticContext("fixed", "Title");
  const dynamicProvider: ContextProvider = dynamicContext(
    "runtime",
    async (ctx) => ({
      hasSignal: ctx.signal !== undefined,
    }),
  );
  const dynamicRunProvider: ContextProvider = dynamicContext(
    "runtime-run",
    (_ctx, run) => ({
      agent: run?.agentName,
      inputCount: run?.input.length ?? 0,
    }),
  );
  void [
    syncContext,
    asyncContext,
    staticProvider,
    dynamicProvider,
    dynamicRunProvider,
  ];

  const resolveCtx: ContextResolveContext = {
    agentName: "typed",
    input: [user("new")],
    prior: [user("old")],
    messages: [user("old"), user("new")],
    contextWindow: { maxTokens: 100 },
  };
  void resolveCtx;

  const item: ContextItem = { title: "T", content: ["a", "b"] };
  void item;

  const syncStrategy: ContextStrategy = {
    name: "sync-strategy",
    reduce(messages, ctx) {
      const max: number = ctx.maxTokens;
      const count: number = ctx.countTokens(messages);
      const model: string = ctx.model;
      void [max, count, model];
      return messages.slice(-1);
    },
  };

  const asyncStrategy: ContextStrategy = {
    name: "async-strategy",
    async reduce(messages, ctx: ContextStrategyContext) {
      await ctx.provider.complete({ model: ctx.model, messages }, ctx.engine);
      return messages;
    },
  };

  const windowOptions: ContextWindowOptions = {
    maxTokens: 100,
    strategy: syncStrategy,
    countTokens: (messages) => messages.length,
  };
  const asyncWindowOptions: ContextWindowOptions = {
    maxTokens: 100,
    strategy: asyncStrategy,
  };
  void [windowOptions, asyncWindowOptions];

  const strategyCtx: ContextStrategyContext = {
    maxTokens: 100,
    countTokens: () => 1,
    provider: mockProvider(),
    model: "mock-model",
    engine: {},
  };
  void strategyCtx;

  const badStore: SessionStore = {
    load: async () => undefined,
    // @ts-expect-error SessionStore.append receives a readonly message array.
    append: async (_id: string, _messages: string[]) => ({}),
    setMetadata: async () => {},
    list: async () => ({ sessions: [] }),
    save: async () => {},
    claimTenant: async () => true,
    delete: async () => {},
  };
  // @ts-expect-error maxTokens is required for context-window options.
  const badWindow: ContextWindowOptions = { strategy: syncStrategy };
  void [badStore, badWindow];
}

describe("session/context type contract", () => {
  it("keeps store, session, context provider, and strategy typings stable", () => {
    void assertSessionAndContextTypes;
    expect(true).toBe(true);
  });
});
