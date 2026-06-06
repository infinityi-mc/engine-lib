/**
 * Example 1 — incident analysis.
 *
 * A monitoring component detects a crash and asks an "incident analyst" agent to
 * investigate. Recent logs are injected as run-time context, and the agent is
 * given a read-only `fetch_recent_logs` tool. Mirrors README "Example 1".
 *
 * Run it:  `bun examples/incident-analysis.ts`
 *
 * In your own app, swap in a real provider such as
 * `createAnthropic({ apiKey, model })`. This example uses a scripted provider so
 * it runs offline, with no API key.
 */

import { defineAgent } from "@infinityi/engine-lib/agent";
import { runAgent } from "@infinityi/engine-lib/execution";
import { staticContext } from "@infinityi/engine-lib/context";
import { defineTool } from "@infinityi/engine-lib/tools";
import { s } from "@infinityi/engine-lib/schema";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

// A read-only tool the agent may call. In a real deployment `execute` would hit
// your log store; here it returns a fixed slice.
const fetchRecentLogs = defineTool({
  name: "fetch_recent_logs",
  description: "Fetch the last N log lines for a service.",
  parameters: s.object({
    service: s.string(),
    lines: s.optional(s.number({ int: true })),
  }),
  execute: ({ service, lines }) => ({
    ok: true,
    content: [
      `[${service}] OutOfMemoryError: Java heap space`,
      `[${service}] GC overhead limit exceeded (${lines ?? 200} lines scanned)`,
    ].join("\n"),
  }),
});

// Real provider (swap in for production):
//   import { createAnthropic } from "@infinityi/engine-lib/providers";
//   const provider = createAnthropic({ apiKey, model: "claude-sonnet-4" });
// Scripted provider: turn 1 calls the tool, turn 2 produces the analysis.
const provider = scriptedProvider([
  toolCallResult([
    {
      id: "c1",
      name: "fetch_recent_logs",
      arguments: { service: "checkout", lines: 200 },
    },
  ]),
  textResult(
    "Root cause: the checkout service ran out of heap (OutOfMemoryError), confirmed " +
      "by the GC overhead messages in the logs. Next steps: raise -Xmx, capture a heap " +
      "dump on OOM, and review the recent deploy for an unbounded cache.",
  ),
]);

const incidentAnalyst = defineAgent({
  name: "incident-analyst",
  provider,
  instructions:
    "You are an SRE assistant. Diagnose the likely root cause of the crash and " +
    "propose concrete next steps. Cite the log lines you relied on.",
  tools: [fetchRecentLogs],
});

async function onServerCrash(event: {
  service: string;
  exitCode: number;
  timestamp: string;
  version: string;
}) {
  const result = await runAgent(incidentAnalyst, {
    input: `Service "${event.service}" crashed with exit code ${event.exitCode}.`,
    context: [
      staticContext({
        crashedAt: event.timestamp,
        deployedVersion: event.version,
      }),
    ],
    onEvent: (e) => {
      if (e.type === "tool.call") console.log(`  ↻ tool call: ${e.name}`);
    },
  });
  console.log("\n--- incident analysis ---");
  console.log(result.output);
  console.log(`\n(steps: ${result.steps}, agent: ${result.agent})`);
}

await onServerCrash({
  service: "checkout",
  exitCode: 137,
  timestamp: new Date().toISOString(),
  version: "2.4.1",
});
