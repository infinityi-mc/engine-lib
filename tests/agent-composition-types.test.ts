import { describe, expect, it } from "bun:test";

import {
  asTool,
  createAgentRegistry,
  defineAgent,
  defineTool,
  type AgentDefinition,
  type AgentHooks,
  type AsToolOptions,
  type Instructions,
} from "../src/agent/index";
import type { ToolContext, ToolDefinition } from "../src/tools/index";
import { s } from "../src/schema/index";
import { mockProvider } from "../src/testing/index";

const provider = mockProvider();
const ctx = undefined as unknown as ToolContext;

const readFile = defineTool({
  name: "read_file",
  parameters: s.object({ path: s.string() }),
  execute: ({ path }) => ({ ok: true, content: path }),
});

function assertAgentAuthoringTypes(): void {
  const staticInstructions: Instructions = "Be precise.";
  const dynamicInstructions: Instructions = async (ctx) => {
    const name: string = ctx.agent.name;
    const signal: AbortSignal | undefined = ctx.signal;
    void signal;
    return `You are ${name}.`;
  };

  const hooks: AgentHooks = {
    onStart: ({ agent, messages }, engine) => {
      const name: string = agent.name;
      const count: number = messages.length;
      const signal: AbortSignal | undefined = engine.signal;
      void [name, count, signal];
    },
    onStep: ({ step, result }) => {
      const n: number = step;
      const model: string = result.model;
      void [n, model];
    },
    onToolCall: ({ call, tool }) => {
      const id: string = call.id;
      const toolName: string = tool.name;
      void [id, toolName];
    },
    onToolResult: ({ result }) => {
      if (!result.ok) {
        const error: string = result.error;
        void error;
      }
    },
    onFinish: ({ output, usage }) => {
      const text: string = output;
      const total: number | undefined = usage?.totalTokens;
      void [text, total];
    },
    onError: ({ error }) => {
      const name: string = error.name;
      void name;
    },
    onHandoff: ({ from, to }) => {
      const pair: [string, string] = [from.name, to.name];
      void pair;
    },
  };

  const billing = defineAgent({
    name: "billing",
    provider,
    instructions: staticInstructions,
    tools: [readFile],
    hooks,
  });

  const support = defineAgent({
    name: "support",
    provider,
    instructions: dynamicInstructions,
  });

  const router = defineAgent({
    name: "router",
    provider,
    handoffs: [billing, "support"],
    generation: {
      model: "mock-model",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 500,
      stopSequences: ["END"],
      toolChoice: "auto",
    },
  });

  const handoffs: readonly (AgentDefinition | string)[] | undefined = router.handoffs;
  void handoffs;

  // @ts-expect-error handoff targets must be an AgentDefinition or string.
  defineAgent({ name: "bad-router", provider, handoffs: [123] });
  // @ts-expect-error toolChoice is constrained to the public ToolChoice union.
  defineAgent({ name: "bad-generation", provider, generation: { toolChoice: "sometimes" } });

  const registry = createAgentRegistry([billing]);
  registry.register(support);
  const resolved: AgentDefinition = registry.resolve("support");
  const listed: readonly AgentDefinition[] = registry.list();
  void [resolved, listed];

  const childTool = asTool(support);
  const defaultTool: ToolDefinition<{ input: string }> = childTool;
  childTool.execute({ input: "please help" }, ctx);
  // @ts-expect-error default asTool schema requires input.
  childTool.execute({}, ctx);

  const options: AsToolOptions<{ query: string; limit?: number }> = {
    name: "delegate_search",
    parameters: s.object({
      query: s.string(),
      limit: s.optional(s.number({ int: true })),
    }),
    toInput: ({ query, limit }) => `${query} ${limit ?? ""}`,
  };
  const customTool = asTool(support, options);
  customTool.execute({ query: "refund", limit: 3 }, ctx);
  customTool.execute({ query: "refund" }, ctx);
  // @ts-expect-error custom asTool args require query.
  customTool.execute({ limit: 3 }, ctx);

  void [defaultTool, customTool];
}

describe("agent composition type contract", () => {
  it("keeps defineAgent, hooks, handoffs, registry, and asTool typings stable", () => {
    void assertAgentAuthoringTypes;
    expect(true).toBe(true);
  });
});
