import {
  createSession,
  defineAgent,
  defineTool,
  runAgent,
  s,
  staticContext,
} from "@infinityi/engine-lib";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

const serviceStatus = defineTool({
  name: "service_status",
  description: "Read current status for a production service.",
  parameters: s.object({
    service: s.enum(["api", "worker", "billing"]),
  }),
  execute: ({ service }) => ({
    ok: true,
    content: {
      service,
      status: "degraded",
      signals: [
        "p95 latency above SLO",
        "error rate normal",
        "recent deploy: 42",
      ],
    },
  }),
});

const incidentAgent = defineAgent({
  name: "incident-analyst",
  instructions:
    "Analyze incidents with evidence. Keep the final answer actionable.",
  tools: [serviceStatus],
  provider: scriptedProvider([
    toolCallResult([
      { id: "status-1", name: "service_status", arguments: { service: "api" } },
    ]),
    textResult(
      "API latency is degraded. The leading suspect is deploy 42; roll back or inspect its database path.",
    ),
  ]),
});

const session = createSession({ id: "incident-2026-06-11" });
const events: string[] = [];

const result = await runAgent(incidentAgent, {
  input: "Why is the API slow?",
  session,
  context: [
    staticContext({ region: "us-east-1", severity: "sev2" }, "Incident"),
  ],
  onEvent: (event) => events.push(event.type),
});

console.log({
  output: result.output,
  events,
  persistedMessages: (await session.messages()).map((message) => message.role),
});
