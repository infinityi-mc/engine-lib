import { describe, expect, it } from "bun:test";

import { AgentError, CancelledError, ExecutionError, MaxHandoffsExceededError } from "../src/errors";
import {
  asTool,
  createAgentRegistry,
  defineAgent,
  defineTool,
  handoffProviderTools,
  handoffToolName,
  resolveHandoffTargets,
} from "../src/agent/index";
import { runAgent } from "../src/execution/index";
import type { RunEvent } from "../src/execution/index";
import type { CompletionRequest, CompletionResult, ToolCall, Usage } from "../src/providers/types";
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

/** A provider that yields each scripted result once, then throws on the next call. */
function throwingAfter(results: CompletionResult[]) {
  let i = 0;
  return mockProvider({
    result: () => {
      if (i < results.length) return results[i++]!;
      throw new Error("provider blew up");
    },
  });
}

const noop = defineTool({
  name: "noop",
  parameters: s.object({}),
  execute: () => ({ ok: true, content: "noop" }),
});

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

  it("folds a failing child's partial usage into the parent total", async () => {
    // Child consumes 9 tokens on its first turn, then its provider throws.
    const child = defineAgent({
      name: "researcher",
      provider: throwingAfter([
        toolCallResult(
          [{ id: "n1", name: "noop", arguments: {} }],
          { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        ),
      ]),
      tools: [noop],
    });
    const parent = defineAgent({
      name: "lead",
      provider: scriptedProvider([
        toolCallResult(
          [{ id: "c1", name: "researcher", arguments: { input: "x" } }],
          { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        ),
        textResult("recovered", { inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      ]),
      tools: [asTool(child)],
    });

    const result = await runAgent(parent, { input: "go" });
    expect(result.output).toBe("recovered");
    // parent step 1 (7) + child's partial usage before failing (9) + parent step 2 (3).
    expect(result.usage.totalTokens).toBe(19);
  });

  it("stamps tokens-consumed-so-far onto the error of a failed run", async () => {
    const agent = defineAgent({
      name: "doomed",
      provider: throwingAfter([
        toolCallResult(
          [{ id: "n1", name: "noop", arguments: {} }],
          { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        ),
      ]),
      tools: [noop],
    });

    let caught: unknown;
    try {
      await runAgent(agent, { input: "go" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).usage?.totalTokens).toBe(9);
  });

  it("accounts for tool usage when the run is aborted during tool execution", async () => {
    const controller = new AbortController();
    const greedy = defineTool({
      name: "greedy",
      parameters: s.object({}),
      execute: (_args, ctx) => {
        ctx.run?.reportUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 5 });
        controller.abort();
        return { ok: true, content: "done" };
      },
    });
    const agent = defineAgent({
      name: "host",
      provider: scriptedProvider([
        toolCallResult(
          [{ id: "g1", name: "greedy", arguments: {} }],
          { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        ),
        textResult("never reached"),
      ]),
      tools: [greedy],
    });

    let caught: unknown;
    try {
      await runAgent(agent, { input: "go", signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CancelledError);
    // provider turn (7) + tool's bridged usage (5), folded before the abort check.
    expect((caught as AgentError).usage?.totalTokens).toBe(12);
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

// --- handoff / delegation -------------------------------------------------

const transfer = (id: string, to: string): ToolCall => ({
  id,
  name: handoffToolName(to),
  arguments: {},
});

describe("handoff helpers", () => {
  it("names the synthetic transfer tool and builds its provider schema", () => {
    expect(handoffToolName("billing")).toBe("transfer_to_billing");

    const router = defineAgent({ name: "router", provider, handoffs: [billing, support] });
    const targets = resolveHandoffTargets(router);
    expect([...targets.keys()]).toEqual(["transfer_to_billing", "transfer_to_support"]);
    expect(targets.get("transfer_to_billing")).toBe(billing);

    const tools = handoffProviderTools(targets);
    expect(tools.map((t) => t.name)).toEqual(["transfer_to_billing", "transfer_to_support"]);
    expect(tools[0]?.description).toContain("billing");
    expect(tools[0]?.parameters).toBeDefined();
  });

  it("resolves string targets via the registry and rejects unknown ones", () => {
    const registry = createAgentRegistry([billing]);
    const router = defineAgent({ name: "router", provider, handoffs: ["billing"] });
    expect(resolveHandoffTargets(router, registry).get("transfer_to_billing")).toBe(billing);

    const bad = defineAgent({ name: "router", provider, handoffs: ["ghost"] });
    expect(() => resolveHandoffTargets(bad, registry)).toThrow(ExecutionError);
    // A string target with no registry is a clear configuration error.
    expect(() => resolveHandoffTargets(bad)).toThrow(/no registry was provided/);
  });
});

describe("handoff — delegation in the run loop", () => {
  it("switches the active agent, preserves history, and records the trail", async () => {
    const specialist = defineAgent({
      name: "billing",
      instructions: "you are billing",
      provider: scriptedProvider([
        textResult("refund issued", { inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      ]),
    });
    const router = defineAgent({
      name: "triage",
      instructions: "route the request",
      handoffs: [specialist],
      provider: scriptedProvider([
        toolCallResult([transfer("h1", "billing")], { inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
      ]),
    });

    const events: RunEvent[] = [];
    const result = await runAgent(router, {
      input: "I need a refund",
      onEvent: (e) => events.push(e),
    });

    expect(result.output).toBe("refund issued");
    // The specialist produced the final answer; the trail records the switch.
    expect(result.agent).toBe("billing");
    expect(result.handoffs).toEqual(["billing"]);
    // Usage spans both agents: triage turn (7) + billing turn (5).
    expect(result.usage.totalTokens).toBe(12);

    const handoff = events.find((e) => e.type === "agent.handoff");
    expect(handoff).toMatchObject({ type: "agent.handoff", from: "triage", to: "billing" });

    // History is preserved across the switch: the original user input survives.
    const userText = result.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .some((p) => p.type === "text" && p.text === "I need a refund");
    expect(userText).toBe(true);
    // The synthetic transfer call was acknowledged with a tool-result message.
    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("advertises the synthetic transfer tool to the model", async () => {
    let advertised: string[] = [];
    const router = defineAgent({
      name: "triage",
      handoffs: [billing],
      provider: mockProvider({
        onRequest: (req: CompletionRequest) => {
          advertised = (req.tools ?? []).map((t) => t.name);
        },
        result: textResult("done"),
      }),
    });

    await runAgent(router, { input: "hi" });
    expect(advertised).toContain("transfer_to_billing");
  });

  it("resolves a string-named handoff target through RunOptions.registry", async () => {
    const specialist = defineAgent({
      name: "billing",
      provider: scriptedProvider([textResult("billing handled")]),
    });
    const registry = createAgentRegistry([specialist]);
    const router = defineAgent({
      name: "triage",
      handoffs: ["billing"],
      provider: scriptedProvider([toolCallResult([transfer("h1", "billing")])]),
    });

    const result = await runAgent(router, { input: "go", registry });
    expect(result.output).toBe("billing handled");
    expect(result.agent).toBe("billing");
  });

  it("fails clearly when a string handoff target has no registry", async () => {
    const router = defineAgent({
      name: "triage",
      handoffs: ["billing"],
      provider: scriptedProvider([toolCallResult([transfer("h1", "billing")])]),
    });

    let caught: unknown;
    try {
      await runAgent(router, { input: "go" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutionError);
    expect((caught as Error).message).toMatch(/no registry was provided/);
  });

  it("runs a real tool and a handoff requested in the same turn", async () => {
    let toolRan = false;
    const log = defineTool({
      name: "log",
      parameters: s.object({}),
      execute: () => {
        toolRan = true;
        return { ok: true, content: "logged" };
      },
    });
    const specialist = defineAgent({
      name: "billing",
      provider: scriptedProvider([textResult("billing done")]),
    });
    const router = defineAgent({
      name: "triage",
      tools: [log],
      handoffs: [specialist],
      provider: scriptedProvider([
        toolCallResult([
          { id: "t1", name: "log", arguments: {} },
          transfer("h1", "billing"),
        ]),
      ]),
    });

    const events: RunEvent[] = [];
    const result = await runAgent(router, { input: "go", onEvent: (e) => events.push(e) });

    expect(toolRan).toBe(true);
    expect(result.agent).toBe("billing");
    expect(result.output).toBe("billing done");
    // Both the real tool result and the handoff were surfaced.
    const toolResults = events.filter((e) => e.type === "tool.result");
    expect(toolResults.map((e) => e.type === "tool.result" && e.name)).toEqual([
      "log",
      "transfer_to_billing",
    ]);
  });

  it("caps ping-pong handoffs with MaxHandoffsExceededError", async () => {
    const a = defineAgent({
      name: "a",
      handoffs: ["b"],
      provider: scriptedProvider([toolCallResult([transfer("x", "b")])]),
    });
    const b = defineAgent({
      name: "b",
      handoffs: ["a"],
      provider: scriptedProvider([toolCallResult([transfer("y", "a")])]),
    });
    const registry = createAgentRegistry([a, b]);

    let caught: unknown;
    try {
      await runAgent(a, { input: "go", registry, maxHandoffs: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MaxHandoffsExceededError);
    expect((caught as MaxHandoffsExceededError).handoffs).toBe(2);
  });

  it("rejects a handoff target whose tool name collides with a real tool", async () => {
    const collide = defineTool({
      name: "transfer_to_billing",
      parameters: s.object({}),
      execute: () => ({ ok: true, content: "x" }),
    });
    const router = defineAgent({
      name: "triage",
      tools: [collide],
      handoffs: [billing],
      provider: scriptedProvider([textResult("never")]),
    });

    let caught: unknown;
    try {
      await runAgent(router, { input: "go" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutionError);
    expect((caught as Error).message).toMatch(/collides with a handoff target/);
  });
});
