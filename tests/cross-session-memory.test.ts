import { describe, expect, it } from "bun:test";

import { InMemoryVectorStore } from "../src/retrieval/index";
import type { EmbeddingProvider, MemoryStore } from "../src/retrieval/index";
import {
  createTenantScopedMemory,
  memoryContextProvider,
  memoryExtractor,
  tenantMemoryFilter,
  vectorMemoryStore,
} from "../src/retrieval/index";
import type {
  ContextProvider,
  ContextResolveContext,
} from "../src/context/index";
import type { Logger } from "../src/runtime/index";
import { user } from "../src/messages/index";
import { regexRedactor } from "../src/governance/index";

// Deterministic toy embedding: a 3-axis bag-of-keywords so similar text scores high.
function toyVector(text: string): readonly number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes("coffee") ? 1 : 0,
    lower.includes("typescript") ? 1 : 0,
    lower.includes("dog") ? 1 : 0,
  ];
}

function toyEmbeddings(): EmbeddingProvider {
  return {
    name: "toy",
    defaultModel: "toy-embedding",
    dimensions: 3,
    async embed(req) {
      return {
        model: req.model ?? "toy-embedding",
        dimensions: 3,
        vectors: req.input.map(toyVector),
      };
    },
  };
}

function makeStore(): MemoryStore {
  return vectorMemoryStore({
    embeddings: toyEmbeddings(),
    store: new InMemoryVectorStore({ dimensions: 3 }),
  });
}

function resolveContext(provider: ContextProvider, query: string) {
  const run: ContextResolveContext = {
    agentName: "a",
    input: [user(query)],
    prior: [],
    messages: [user(query)],
  };
  return provider.resolve({}, run);
}

describe("MEM-T1 vectorMemoryStore", () => {
  it("stores and recalls semantically-related entries with their source (AC-12)", async () => {
    const memory = makeStore();
    await memory.store({
      content: "The user prefers coffee in the morning",
      source: {
        sessionId: "s1",
        runId: "r1",
        timestamp: "2026-06-15T00:00:00Z",
      },
    });
    await memory.store({
      content: "The user owns a dog named Rex",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:01:00Z" },
    });

    const hits = await memory.recall("what drink does the user like (coffee)", {
      topK: 1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("coffee");
    expect(hits[0]?.source.sessionId).toBe("s1");
    expect(hits[0]?.source.runId).toBe("r1");
  });
});

describe("MEM-T1 memoryContextProvider", () => {
  it("injects recalled memories as system context, not history, and emits onRecalled (AC-13)", async () => {
    const memory = makeStore();
    await memory.store({
      content: "The user writes TypeScript daily",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:00:00Z" },
    });

    let recalledCount = -1;
    const provider = memoryContextProvider({
      memory,
      topK: 3,
      onRecalled: (entries) => {
        recalledCount = entries.length;
      },
    });

    const items = await resolveContext(provider, "help me with typescript");
    expect(items).toHaveLength(1);
    expect(String(items[0]?.content)).toContain("TypeScript");
    expect(recalledCount).toBe(1);
  });

  it("degrades to no memories when recall throws (AC-16)", async () => {
    const failing: MemoryStore = {
      store: async () => {},
      recall: async () => {
        throw new Error("recall down");
      },
    };
    const provider = memoryContextProvider({ memory: failing });
    const items = await resolveContext(provider, "anything");
    expect(items).toEqual([]);
  });

  it("keeps recalled context when onRecalled throws", async () => {
    const memory = makeStore();
    await memory.store({
      content: "The user writes TypeScript daily",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:00:00Z" },
    });
    const warnings: unknown[] = [];
    const provider = memoryContextProvider({
      memory,
      onRecalled: () => {
        throw new Error("callback down");
      },
    });
    let logger: Logger;
    logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (_message, meta) => void warnings.push(meta),
      error: () => {},
      fatal: () => {},
      child: () => logger,
    };

    const items = await provider.resolve(
      {
        logger,
      },
      {
        agentName: "a",
        input: [user("typescript")],
        prior: [],
        messages: [user("typescript")],
      },
    );

    expect(items).toHaveLength(1);
    expect(String(items[0]?.content)).toContain("TypeScript");
    expect(warnings).toHaveLength(1);
  });
});

describe("MEM-T1 memoryExtractor", () => {
  it("stamps runId/sessionId on stored memories (AC-14)", async () => {
    const stored: Array<{
      content: string;
      runId?: string;
      sessionId: string;
    }> = [];
    const memory: MemoryStore = {
      store: async (entry) => {
        stored.push({
          content: entry.content,
          ...(entry.source.runId !== undefined
            ? { runId: entry.source.runId }
            : {}),
          sessionId: entry.source.sessionId,
        });
      },
      recall: async () => [],
    };
    const hook = memoryExtractor({
      memory,
      sessionId: "s1",
      runId: "r1",
      extract: ({ output }) => [output],
    });
    await hook({ output: "remember this fact" }, {});
    expect(stored).toEqual([
      { content: "remember this fact", runId: "r1", sessionId: "s1" },
    ]);
  });

  it("redacts memories before storage when filters are supplied (NFR-6)", async () => {
    const stored: string[] = [];
    const memory: MemoryStore = {
      store: async (entry) => void stored.push(entry.content),
      recall: async () => [],
    };
    const hook = memoryExtractor({
      memory,
      sessionId: "s1",
      filters: [regexRedactor()],
      extract: () => ["contact me at alice@example.com"],
    });
    await hook({ output: "" }, {});
    expect(stored[0]).not.toContain("alice@example.com");
    expect(stored[0]).toContain("[REDACTED]");
  });

  it("a store failure never throws out of the hook", async () => {
    const memory: MemoryStore = {
      store: async () => {
        throw new Error("store down");
      },
      recall: async () => [],
    };
    const hook = memoryExtractor({
      memory,
      sessionId: "s1",
      extract: () => ["x"],
    });
    await expect(hook({ output: "x" }, {})).resolves.toBeUndefined();
  });
});

describe("MEM-T1 tenant filtering (AC-15)", () => {
  it("recall only returns memories whose metadata tenant matches", async () => {
    const memory = makeStore();
    await memory.store({
      content: "tenant one likes coffee",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:00:00Z" },
      metadata: { tenantId: "t1" },
    });
    await memory.store({
      content: "tenant two likes coffee",
      source: { sessionId: "s2", timestamp: "2026-06-15T00:01:00Z" },
      metadata: { tenantId: "t2" },
    });

    const hits = await memory.recall("coffee", {
      topK: 5,
      filter: tenantMemoryFilter("t1"),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("tenant one");
    expect(hits[0]?.metadata?.tenantId).toBe("t1");
  });

  it("memoryContextProvider applies the tenant filter by default", async () => {
    const memory = makeStore();
    await memory.store({
      content: "tenant one likes coffee",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:00:00Z" },
      metadata: { tenantId: "t1" },
    });
    await memory.store({
      content: "tenant two likes coffee",
      source: { sessionId: "s2", timestamp: "2026-06-15T00:01:00Z" },
      metadata: { tenantId: "t2" },
    });

    const provider = memoryContextProvider({ memory, tenantId: "t1" });
    const items = await resolveContext(provider, "coffee");

    expect(items).toHaveLength(1);
    expect(String(items[0]?.content)).toContain("tenant one");
    expect(String(items[0]?.content)).not.toContain("tenant two");
  });

  it("tenant-scoped memory stamps and enforces tenant metadata", async () => {
    const base = makeStore();
    const scoped = createTenantScopedMemory(base, "t1");
    await scoped.store({
      content: "tenant one likes coffee",
      source: { sessionId: "s1", timestamp: "2026-06-15T00:00:00Z" },
      metadata: { tenantId: "attacker", category: "preference" },
    });
    await base.store({
      content: "tenant two likes coffee",
      source: { sessionId: "s2", timestamp: "2026-06-15T00:01:00Z" },
      metadata: { tenantId: "t2", category: "preference" },
    });

    const hits = await scoped.recall("coffee", {
      topK: 5,
      filter: (record) => record.metadata?.category === "preference",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("tenant one");
    expect(hits[0]?.metadata?.tenantId).toBe("t1");
  });
});
