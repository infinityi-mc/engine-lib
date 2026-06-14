import { defineAgent, defineTool, runAgent, s } from "@infinityi/engine-lib";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

const lookupService = defineTool({
  name: "lookup_service",
  description: "Return status for an internal service.",
  parameters: s.object({
    service: s.enum(["api", "worker", "billing"]),
  }),
  execute: ({ service }) => ({
    ok: true,
    content: {
      service,
      status: service === "billing" ? "degraded" : "healthy",
      since: "2026-06-11T12:00:00Z",
    },
  }),
});

const agent = defineAgent({
  name: "status",
  tools: [lookupService],
  provider: scriptedProvider([
    toolCallResult([
      {
        id: "call-1",
        name: "lookup_service",
        arguments: { service: "billing" },
      },
    ]),
    textResult("Billing is degraded and has been since 2026-06-11T12:00:00Z."),
  ]),
});

const result = await runAgent(agent, { input: "Check billing." });

console.log(result.output);
