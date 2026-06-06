/**
 * Example 3 — multi-agent coordination (Phase 7).
 *
 * Two complementary composition patterns, both driven by the same `runAgent`
 * loop (no separate orchestrator):
 *   1. Handoff/delegation — a triage agent transfers the conversation to a
 *      specialist via a synthetic `transfer_to_<name>` tool.
 *   2. Sub-agent-as-tool — a lead agent invokes a researcher agent through the
 *      normal tool-calling path with `asTool(...)`.
 *
 * Run it:  `bun examples/multi-agent.ts`
 *
 * Imports from `../src` with scripted providers so it runs offline.
 */

import { asTool, defineAgent } from "../src/agent/index";
import { runAgent } from "../src/execution/index";
import { scriptedProvider, textResult, toolCallResult } from "../src/testing/index";

// --- 1. Handoff / delegation ---------------------------------------------

const billing = defineAgent({
  name: "billing",
  provider: scriptedProvider([textResult("I've issued your refund — it'll land in 3-5 days.")]),
  instructions: "Handle billing and refunds.",
});

// Triage's model calls the synthetic `transfer_to_billing` tool to hand off.
const triage = defineAgent({
  name: "triage",
  provider: scriptedProvider([toolCallResult([{ id: "h1", name: "transfer_to_billing", arguments: {} }])]),
  instructions: "Route the user to the right specialist.",
  handoffs: [billing],
});

const handoffResult = await runAgent(triage, { input: "I want a refund" });
console.log("=== handoff ===");
console.log("answer:", handoffResult.output);
console.log("final agent:", handoffResult.agent, "| trail:", handoffResult.handoffs);

// --- 2. Sub-agent-as-tool -------------------------------------------------

const researcher = defineAgent({
  name: "researcher",
  provider: scriptedProvider([textResult("Bun is a fast all-in-one JS runtime, bundler, and test runner.")]),
  instructions: "Research deeply and report concisely.",
});

const lead = defineAgent({
  name: "lead",
  // Turn 1: delegate to the researcher tool. Turn 2: summarize its finding.
  provider: scriptedProvider([
    toolCallResult([{ id: "c1", name: "researcher", arguments: { input: "What is Bun?" } }]),
    textResult("Summary: Bun is a fast all-in-one JavaScript runtime/bundler/test-runner."),
  ]),
  instructions: "Delegate research, then summarize.",
  tools: [asTool(researcher, { description: "Delegate research to a specialist." })],
});

const childEvents: string[] = [];
const toolResult = await runAgent(lead, {
  input: "Give me a one-line summary of Bun.",
  onEvent: (e) => {
    if (e.type === "agent.child") childEvents.push(`${e.agent}@depth${e.depth}: ${e.event.type}`);
  },
});
console.log("\n=== sub-agent-as-tool ===");
console.log("answer:", toolResult.output);
console.log("child events:", childEvents.length, "(e.g.", childEvents[0] + ")");
