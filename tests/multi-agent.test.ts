import { describe, expect, it } from "bun:test";

import { ExecutionError } from "../src/errors";
import { asTool, createAgentRegistry, defineAgent, defineTool } from "../src/agent/index";
import { runAgent } from "../src/execution/index";
import type { RunEvent } from "../src/execution/index";
import type { CompletionResult, ToolCall, Usage } from "../src/providers/types";
import { s } from "../src/schema/index";
import { mockProvider } from "../src/testing/index";

const provider = mockProvider({ name: "mock", defaultModel: "mock-model" });

const triage = defineAgent({ name: "triage", provider, instructions: "route" });
const billing = defineAgent({ name: "billing", provider, instructions: "billing" });
const support = defineAgent({ name: "support", provider, instructions: "support" });

describe("createAgentRegistry", () => {
  it("seeds, looks up, and lists agents in registration order", () => {
    const registry = createAgentRegistry([triage, billing]);

    expect(registry.size).toBe(2);
    expect(registry.has("triage")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("billing")).toBe(billing);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().map((a) => a.name)).toEqual(["triage", "billing"]);
  });

  it("starts empty when no agents are provided", () => {
    const registry = createAgentRegistry();
    expect(registry.size).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("registers additional agents after construction", () => {
    const registry = createAgentRegistry([triage]);
    registry.register(support);

    expect(registry.size).toBe(2);
    expect(registry.resolve("support")).toBe(support);
    expect(registry.list().map((a) => a.name)).toEqual(["triage", "support"]);
  });

  it("returns a stable snapshot from list() that a later register() cannot mutate", () => {
    const registry = createAgentRegistry([triage]);
    const snapshot = registry.list();
    expect(snapshot).toHaveLength(1);

    registry.register(billing);
    expect(snapshot).toHaveLength(1);
    expect(registry.list()).toHaveLength(2);
  });

  it("resolve() returns the agent or throws a clear ExecutionError", () => {
    const registry = createAgentRegistry([triage]);
    expect(registry.resolve("triage")).toBe(triage);
    expect(() => registry.resolve("nope")).toThrow(ExecutionError);
    expect(() => registry.resolve("nope")).toThrow('unknown agent: "nope"');
  });

  it("fails fast on a duplicate name when seeding", () => {
    const dupe = defineAgent({ name: "triage", provider });
    expect(() => createAgentRegistry([triage, dupe])).toThrow(ExecutionError);
    expect(() => createAgentRegistry([triage, dupe])).toThrow(
      'duplicate agent name: "triage"',
    );
  });

  it("fails fast on a duplicate name when registering", () => {
    const registry = createAgentRegistry([triage]);
    const dupe = defineAgent({ name: "triage", provider });
    expect(() => registry.register(dupe)).toThrow(ExecutionError);
  });
});

// --- sub-agent-as-tool (asTool) -------------------------------------------

function textResult(text: string, usage?: Usage): CompletionResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolCalls: [],
    finishReason: "stop",
    model: "mock-model",
    raw: {},
    ...(usage !== undefined ? { usage } : {}),
  };
}

function toolCallResult(calls: ToolCall[], usage?: Usage): CompletionResult {
  return {
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "tool_call", id: c.id, name: c.name, arguments: c.arguments })),
    },
    toolCalls: calls,
    finishReason: "tool_calls",
    model: "mock-model",
    raw: {},
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** A provider that returns each scripted result in turn (last one repeats). */
function scriptedProvider(results: CompletionResult[]) {
  let i = 0;
  return mockProvider({ result: () => results[Math.min(i++, results.length - 1)]! });
}

describe("asTool — sub-agent-as-tool", () => {
  it("wraps an agent with a default name/description and `{ input }` schema", () => {
    const child = defineAgent({ name: "researcher", provider });
    const tool = asTool(child);

    expect(tool.name).toBe("researcher");
    expect(tool.description).toContain("researcher");
    expect(tool.parameters.safeParse({ input: "hi" }).success).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.name).toBe(asTool(child, {}).name);
    expect(asTool(child, { name: "delegate", description: "d" }).name).toBe("delegate");
  });

  it("runs the child, feeds its output back, and propagates usage + agent.child events", async () => {
    const child = defineAgent({
      name: "researcher",
      provider: scriptedProvider([
        textResult("child answer", { inputTokens: 5, outputTokens: 7, totalTokens: 12 }),
      ]),
    });
    const parent = defineAgent({
      name: "lead",
      provider: scriptedProvider([
        toolCallResult(
          [{ id: "c1", name: "researcher", arguments: { input: "investigate" } }],
          { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        ),
        textResult("final report", { inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      ]),
      tools: [asTool(child)],
    });

    const events: RunEvent[] = [];
    const result = await runAgent(parent, { input: "go", onEvent: (e) => events.push(e) });

    expect(result.output).toBe("final report");

    // The child's final text was fed back to the parent as the tool result.
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult?.type).toBe("tool.result");
    if (toolResult?.type === "tool.result" && toolResult.result.ok) {
      expect(toolResult.result.content).toBe("child answer");
    } else {
      throw new Error("expected a successful tool.result");
    }

    // Usage = parent step 1 (7) + child (12) + parent step 2 (3).
    expect(result.usage.totalTokens).toBe(22);

    // The child's run surfaced to the parent as agent.child events.
    const childEvents = events.filter(
      (e): e is Extract<RunEvent, { type: "agent.child" }> => e.type === "agent.child",
    );
    expect(childEvents.length).toBeGreaterThan(0);
    expect(childEvents.every((e) => e.agent === "researcher")).toBe(true);
    expect(childEvents.every((e) => e.depth === 1)).toBe(true);
    expect(childEvents.some((e) => e.event.type === "run.finish")).toBe(true);
  });

  it("maps a failing child run to a tool error instead of throwing", async () => {
    const failing = mockProvider({
      result: () => {
        throw new Error("child blew up");
      },
    });
    const child = defineAgent({ name: "researcher", provider: failing });
    const parent = defineAgent({
      name: "lead",
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "researcher", arguments: { input: "x" } }]),
        textResult("recovered"),
      ]),
      tools: [asTool(child)],
    });

    const result = await runAgent(parent, { input: "go" });
    expect(result.output).toBe("recovered");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
  });

  it("increments depth for a sub-agent nested inside another sub-agent", async () => {
    const grandchild = defineAgent({
      name: "grandchild",
      provider: scriptedProvider([textResult("deep")]),
    });
    const child = defineAgent({
      name: "child",
      provider: scriptedProvider([
        toolCallResult([{ id: "g1", name: "grandchild", arguments: { input: "x" } }]),
        textResult("child done"),
      ]),
      tools: [asTool(grandchild)],
    });
    const parent = defineAgent({
      name: "parent",
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "child", arguments: { input: "x" } }]),
        textResult("parent done"),
      ]),
      tools: [asTool(child)],
    });

    const events: RunEvent[] = [];
    await runAgent(parent, { input: "go", onEvent: (e) => events.push(e) });

    const depths = events
      .filter((e): e is Extract<RunEvent, { type: "agent.child" }> => e.type === "agent.child")
      .map((e) => e.depth);
    expect(depths).toContain(1);
    expect(Math.max(...depths)).toBe(2);
  });

  it("still works for a plain tool that ignores ctx.run", async () => {
    let sawBridge = false;
    const plain = defineTool({
      name: "noop",
      parameters: s.object({}),
      execute: (_args, ctx) => {
        sawBridge = ctx.run !== undefined;
        return { ok: true, content: "done" };
      },
    });
    const agent = defineAgent({
      name: "host",
      provider: scriptedProvider([
        toolCallResult([{ id: "t1", name: "noop", arguments: {} }]),
        textResult("ok"),
      ]),
      tools: [plain],
    });

    const result = await runAgent(agent, { input: "go" });
    expect(result.output).toBe("ok");
    // The loop provides the bridge, but ignoring it changes nothing.
    expect(sawBridge).toBe(true);
  });
});
