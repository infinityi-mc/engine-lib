# Retrieval and memory

## Goal

Add host-owned retrieval, document indexing, vector search, and cross-session
memory.

## Prerequisites

- You have read [Sessions and context](./05-sessions-and-context.md)
- You are comfortable with context injection

## Step 1: Index documents

```ts
import {
  InMemoryVectorStore,
  createTextChunker,
  indexDocuments,
  staticDocumentLoader,
  type EmbeddingProvider,
} from "@infinityi/engine-lib/retrieval";

const embeddings: EmbeddingProvider = {
  name: "toy",
  defaultModel: "toy-embedding",
  dimensions: 3,
  async embed(req) {
    return {
      model: req.model ?? "toy-embedding",
      vectors: req.input.map((text) => [text.length, text.includes("database") ? 1 : 0, 1]),
      dimensions: 3,
    };
  },
};

const store = new InMemoryVectorStore({ dimensions: 3 });

await indexDocuments({
  loaders: [
    staticDocumentLoader([
      {
        id: "runbook",
        content: "If the database is unavailable, fail over to the standby.",
        source: { uri: "runbooks/database.md", title: "Database Runbook" },
      },
    ]),
  ],
  chunker: createTextChunker({ maxChars: 1_000, overlapChars: 100 }),
  embeddings,
  store,
});
```

The retrieval module provides contracts and local implementations, not a hosted
RAG service.

## Step 2: Inject retrieved context into a run

```ts
import { createVectorRetriever, retrieverContext } from "@infinityi/engine-lib/retrieval";

const retriever = createVectorRetriever({ embeddings, store, topK: 4 });

await runAgent(agent, {
  input: "How do I recover the database?",
  context: [retrieverContext({ retriever, maxContextTokens: 1_500 })],
});
```

This adapts retrieval back into the existing context-provider flow instead of
adding a separate run-loop abstraction.

## Step 3: Mix lexical and vector retrieval

Use a `KeywordRetriever` with `createVectorRetriever(...)` when you want hybrid
retrieval. `mergeHybridResults(...)` combines vector and lexical scores into a
single ranked result set.

## Step 4: Add cross-session memory

```ts
import {
  memoryContextProvider,
  memoryExtractor,
  vectorMemoryStore,
} from "@infinityi/engine-lib/retrieval";

const memory = vectorMemoryStore({ embeddings, store });

await runAgent(agent, {
  input: "what's my preferred editor?",
  context: [memoryContextProvider({ memory })],
  hooks: {
    onFinish: memoryExtractor({
      memory,
      sessionId: session.id,
      runId: "run-123",
      extract: ({ output }) => [output],
    }),
  },
});
```

Use this when you need relevant facts to persist across separate sessions.

## Step 5: Explore the rest of the retrieval surface

The subpath also includes:

- document loaders: `createDocumentLoader`, `loadDocuments`, `staticDocumentLoader`
- chunking: `createTextChunker`, `recursiveTextChunker`
- vector helpers: `assertVector`, `cosineSimilarity`, `dotProduct`, `euclideanSimilarity`, `scoreVectors`
- memory helpers: `createTenantScopedMemory`, `tenantMemoryFilter`

## Result

You should now be able to:

- index documents
- retrieve relevant context at run time
- build hybrid retrieval
- store and recall cross-session memory

## Next steps

- Add observability in [Events, telemetry, and governance](./09-events-telemetry-and-governance.md)
- Test retrieval flows in [Testing and lifecycle](./10-testing-and-lifecycle.md)
