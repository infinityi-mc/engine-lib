/**
 * Example 4 — Forge lifecycle integration (Phase 8).
 *
 * Boot the engine-lib runtime as a `@infinityi/forge/lifecycle` component:
 * `agentRuntimeComponent` validates providers on start, exposes a health probe,
 * and runs an `onStop` hook on graceful shutdown — all orchestrated by
 * `forge.boot`.
 *
 * Run it:  `bun examples/lifecycle.ts`
 *
 * Uses in-memory doubles so it runs offline. `installSignals: false` + a no-op
 * `exit` keep the example from installing real process signal handlers.
 */

import { boot } from "@infinityi/forge/lifecycle";

import { agentRuntimeComponent } from "../src/lifecycle/index";
import { inMemorySessionStore } from "../src/testing/index";
import { mockProvider } from "../src/testing/index";

const store = inMemorySessionStore();
const runtime = agentRuntimeComponent({
  providers: [mockProvider({ name: "openai", defaultModel: "gpt-5" })],
  sessionStore: store,
  // A real probe would issue a cheap completion; here it's a no-op success.
  probe: () => Promise.resolve(),
  probeOnStart: true,
  onStop: () => console.log("  onStop: flushing session store"),
});

const app = await boot({ components: [runtime], installSignals: false, exit: () => {} });
console.log("booted — ready:", app.ready, "| components:", app.components.map((c) => c.name));

const health = await runtime.healthcheck?.({ signal: new AbortController().signal, logger: console });
console.log("healthcheck:", health?.status, health?.data);

await app.stop("example-complete");
await app.done;
console.log("drained cleanly");
