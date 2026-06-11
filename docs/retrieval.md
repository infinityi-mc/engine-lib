# Retrieval

`@infinityi/engine-lib/retrieval` is an opt-in module for host-owned RAG
pipelines. It provides contracts and small local implementations, then adapts
retrievers back into the existing `ContextProvider` flow.

The module does not provide a hosted retrieval service, managed vector database,
or vendor embedding client. Applications supply those pieces behind the exported
interfaces.

## Index Documents

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

## Inject Retrieved Context

```ts
import {
  createVectorRetriever,
  retrieverContext,
} from "@infinityi/engine-lib/retrieval";

const retriever = createVectorRetriever({ embeddings, store, topK: 4 });

await runAgent(agent, {
  input: "How do I recover the database?",
  context: [retrieverContext({ retriever, maxContextTokens: 1_500 })],
});
```

`retrieverContext` derives the query from the current run input by default,
renders citations such as `[1] Database Runbook, lines 1-3`, and returns no
context when there is no query or no retrieval hit.

## Hybrid Retrieval

Pass a `KeywordRetriever` hook to `createVectorRetriever` when a host wants to
combine lexical and vector search. `mergeHybridResults` normalizes the vector and
keyword score channels independently, de-duplicates by id, applies weights, and
returns ranked `RetrievalResult`s.
