import { defineAgent, runAgent } from "@infinityi/engine-lib";
import {
  InMemoryVectorStore,
  createTextChunker,
  createVectorRetriever,
  indexDocuments,
  retrieverContext,
  staticDocumentLoader,
  type EmbeddingProvider,
} from "@infinityi/engine-lib/retrieval";
import { scriptedProvider, textResult } from "@infinityi/engine-lib/testing";

const embeddings: EmbeddingProvider = {
  name: "toy-embeddings",
  defaultModel: "toy-embedding",
  dimensions: 4,
  async embed(req) {
    return {
      model: req.model ?? "toy-embedding",
      dimensions: 4,
      vectors: req.input.map((text) => [
        text.toLowerCase().includes("database") ? 1 : 0,
        text.toLowerCase().includes("standby") ? 1 : 0,
        text.toLowerCase().includes("cache") ? 1 : 0,
        Math.min(text.length / 100, 1),
      ]),
    };
  },
};

const store = new InMemoryVectorStore({ dimensions: 4 });

await indexDocuments({
  loaders: [
    staticDocumentLoader([
      {
        id: "database-runbook",
        content: "When the database is unavailable, fail over to the standby and verify replication lag.",
        source: { uri: "runbooks/database.md", title: "Database Runbook" },
      },
      {
        id: "cache-runbook",
        content: "When the cache is saturated, scale the cache tier before restarting workers.",
        source: { uri: "runbooks/cache.md", title: "Cache Runbook" },
      },
    ]),
  ],
  chunker: createTextChunker({ maxChars: 120, overlapChars: 20 }),
  embeddings,
  store,
});

const retriever = createVectorRetriever({ embeddings, store, topK: 2 });
const agent = defineAgent({
  name: "retrieval-demo",
  instructions: "Answer from retrieved context and cite sources by marker.",
  provider: scriptedProvider([textResult("Fail over to standby and verify replication lag. [1]")]),
});

const result = await runAgent(agent, {
  input: "How should I recover a database outage?",
  context: [retrieverContext({ retriever, maxContextTokens: 500 })],
});

console.log(result.output);
