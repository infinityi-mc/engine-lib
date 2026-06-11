import { describe, expect, it } from "bun:test";

import { defineAgent } from "../src/agent/index";
import { runAgent } from "../src/execution/index";
import type { Message } from "../src/messages/types";
import type { EmbeddingProvider, RetrievalResult, Retriever } from "../src/retrieval/index";
import {
  InMemoryVectorStore,
  createTextChunker,
  createVectorRetriever,
  indexDocuments,
  loadDocuments,
  mergeHybridResults,
  recursiveTextChunker,
  retrieverContext,
  staticDocumentLoader,
} from "../src/retrieval/index";
import { mockProvider, textResult } from "../src/testing/index";

function textOf(message: Message): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toyVector(text: string): readonly number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes("database") ? 1 : 0,
    lower.includes("cache") ? 1 : 0,
    lower.includes("standby") ? 0.5 : 0,
  ];
}

function toyEmbeddings(onInput?: (input: readonly string[]) => void): EmbeddingProvider {
  return {
    name: "toy",
    defaultModel: "toy-embedding",
    dimensions: 3,
    async embed(req) {
      onInput?.(req.input);
      return {
        model: req.model ?? "toy-embedding",
        dimensions: 3,
        vectors: req.input.map(toyVector),
      };
    },
  };
}

describe("retrieval loaders and chunking", () => {
  it("loads static documents and chunks with source locations", async () => {
    const loader = staticDocumentLoader([
      {
        id: "doc-1",
        content: "line one\nline two\nline three",
        source: { uri: "docs/runbook.md", title: "Runbook" },
      },
    ]);
    const loaded = await loadDocuments([loader]);
    expect(loaded.documents).toHaveLength(1);

    const chunks = await createTextChunker({ maxChars: 12, overlapChars: 2 }).chunk(loaded.documents[0]!, {
      documentIndex: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.id).toBe("doc-1#chunk-1");
    expect(chunks[0]?.source?.title).toBe("Runbook");
    expect(chunks[0]?.source?.location?.startLine).toBe(1);
    expect(chunks[1]?.source?.location?.startOffset).toBeGreaterThan(0);
  });

  it("recursively splits oversized spans by separator priority", async () => {
    const chunks = await recursiveTextChunker({ maxChars: 18, overlapChars: 0, separators: ["\n\n", " "] }).chunk({
      content: "alpha beta gamma delta epsilon",
      source: { title: "Words" },
    }, { documentIndex: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 18)).toBe(true);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["alpha beta gamma", "delta epsilon"]);
  });
});

describe("InMemoryVectorStore", () => {
  it("upserts, replaces, filters, scores, deletes, and clears records", async () => {
    const store = new InMemoryVectorStore({ dimensions: 2 });
    await store.upsert([
      { id: "a", vector: [1, 0], text: "alpha", metadata: { group: "one" } },
      { id: "b", vector: [0, 1], text: "beta", metadata: { group: "two" } },
    ]);

    expect((await store.query({ vector: [1, 0], topK: 1 }))[0]?.id).toBe("a");

    await store.upsert([{ id: "a", vector: [0, 1], text: "alpha replaced", metadata: { group: "one" } }]);
    const filtered = await store.query({
      vector: [0, 1],
      filter: (record) => record.metadata?.group === "one",
      topK: 2,
      includeVectors: true,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.text).toBe("alpha replaced");
    expect(filtered[0]?.vector).toEqual([0, 1]);

    await expect(store.upsert([{ id: "bad", vector: [1, 2, 3], text: "bad" }])).rejects.toThrow(
      /expected 2/,
    );
    await store.delete?.(["a"]);
    expect((await store.stats?.())?.records).toBe(1);
    await store.clear?.();
    expect((await store.stats?.())?.records).toBe(0);
  });
});

describe("indexing and vector retrieval", () => {
  it("indexes documents in batches and retrieves ranked results with sources", async () => {
    const batches: string[][] = [];
    const embeddings = toyEmbeddings((input) => batches.push([...input]));
    const store = new InMemoryVectorStore({ dimensions: 3 });

    const indexed = await indexDocuments({
      loaders: [
        staticDocumentLoader([
          {
            id: "database",
            content: "Database outage: fail over to standby.",
            source: { uri: "runbooks/database.md", title: "Database" },
          },
          {
            id: "cache",
            content: "Cache saturation: scale the cache tier.",
            source: { uri: "runbooks/cache.md", title: "Cache" },
          },
        ]),
      ],
      chunker: createTextChunker({ maxChars: 200 }),
      embeddings,
      store,
      batchSize: 1,
    });

    expect(indexed).toMatchObject({ documents: 2, chunks: 2, records: 2, model: "toy-embedding", dimensions: 3 });
    expect(batches).toHaveLength(2);

    const retriever = createVectorRetriever({ embeddings, store, topK: 1 });
    const results = await retriever.retrieve({ query: "database recovery" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("database#chunk-1");
    expect(results[0]?.source?.uri).toBe("runbooks/database.md");
    expect(results[0]?.scores?.vector).toBeGreaterThan(0);
  });
});

describe("hybrid retrieval", () => {
  it("returns no results when both channels are empty", () => {
    expect(mergeHybridResults([], [])).toEqual([]);
  });

  it("de-duplicates and combines vector and keyword scores", () => {
    const vectorResults: RetrievalResult[] = [
      { id: "a", rank: 1, score: 0.9, text: "vector a" },
      { id: "b", rank: 2, score: 0.1, text: "vector b" },
    ];
    const merged = mergeHybridResults(
      vectorResults,
      [
        { id: "b", score: 10, text: "keyword b" },
        { id: "c", score: 5, text: "keyword c" },
      ],
      { vectorWeight: 0.4, keywordWeight: 0.6, topK: 3 },
    );

    expect(merged.map((result) => result.id)).toEqual(["b", "a", "c"]);
    expect(merged[0]?.rank).toBe(1);
    expect(merged[0]?.scores?.vector).toBe(0.1);
    expect(merged[0]?.scores?.keyword).toBe(10);
  });
});

describe("retrieverContext", () => {
  it("derives the query from run input and renders budgeted citations", async () => {
    let seenQuery = "";
    let selected: readonly RetrievalResult[] = [];
    let requestMessages: readonly Message[] = [];
    const retriever: Retriever = {
      name: "fake",
      async retrieve(query) {
        seenQuery = query.query;
        return [
          {
            id: "r1",
            rank: 1,
            score: 0.9,
            text: `${"database recovery step ".repeat(20)}final tail`,
            source: { title: "Database Runbook", location: { startLine: 2, endLine: 4 } },
          },
          { id: "r2", rank: 2, score: 0.1, text: "cache detail", source: { title: "Cache Runbook" } },
        ];
      },
    };
    const agent = defineAgent({
      name: "a",
      provider: mockProvider({ result: textResult("ok"), onRequest: (req) => { requestMessages = req.messages; } }),
    });

    await runAgent(agent, {
      input: "database outage",
      context: [
        retrieverContext({
          retriever,
          maxContextTokens: 12,
          countTokens: (messages) => Math.ceil(messages.map(textOf).join("").length / 10),
          onResults: (results) => { selected = results; },
        }),
      ],
    });

    const contextMessage = requestMessages.find((message) => textOf(message).includes("Retrieved Context"));
    const contextText = contextMessage === undefined ? "" : textOf(contextMessage);
    expect(seenQuery).toBe("database outage");
    expect(selected.map((result) => result.id)).toEqual(["r1"]);
    expect(contextText).toContain("## Retrieved Context");
    expect(contextText).toContain("[1] Database Runbook, lines 2-4");
    expect(contextText).not.toContain("score=");
    expect(contextText).toContain("[truncated]");
    expect(contextText).not.toContain("final tail");
    expect(contextText).not.toContain("Cache Runbook");
  });

  it("returns no context when no query is available", async () => {
    const retriever: Retriever = {
      name: "fake",
      async retrieve() {
        throw new Error("should not retrieve without a query");
      },
    };
    const provider = retrieverContext({ retriever });
    expect(await provider.resolve({})).toEqual([]);
  });
});
