import { describe, expect, it } from "bun:test";

import { defineAgent, defineTool } from "../src/agent/index";
import { CancelledError, MaxStepsExceededError } from "../src/errors";
import { runAgent } from "../src/execution/index";
import type { RunEvent } from "../src/execution/index";
import type { CompletionResult, ToolCall, Usage } from "../src/providers/types";
import { s } from "../src/schema/index";
import { mockProvider } from "../src/testing/index";

// --- result fixtures -------------------------------------------------------

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
function scriptedProvider(results: CompletionResult[], opts?: { capabilities?: { streaming?: boolean } }) {
  let i = 0;
  return mockProvider({
    ...(opts?.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    result: () => results[Math.min(i++, results.length - 1)]!,
  });
}

// --- tools -----------------------------------------------------------------

const echo = defineTool({
  name: "echo",
  parameters: s.object({ value: s.string() }),
  execute: ({ value }) => ({ ok: true, content: value }),
});
const boom = defineTool({
  name: "boom",
  parameters: s.object({}),
  execute: () => {
    throw new Error("kaboom");
  },
});

// --- tests -----------------------------------------------------------------

describe("runAgent — buffered", () => {
  it("returns the final answer in a single turn", async () => {
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("hello")]) });
    const result = await runAgent(agent, { input: "hi" });
    expect(result.output).toBe("hello");
    expect(result.steps).toBe(1);
    expect(result.finishReason).toBe("stop");
    // history: user input + assistant answer
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("prepends resolved instructions as a system message", async () => {
    const agent = defineAgent({
      name: "a",
      provider: scriptedProvider([textResult("ok")]),
      instructions: (c) => `I am ${c.agent.name}`,
    });
    const result = await runAgent(agent, { input: "hi" });
    expect(result.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "I am a" }] });
  });

  it("runs a tool round-trip and feeds the result back", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: "yo" } }]),
        textResult("done"),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    expect(result.output).toBe("done");
    expect(result.steps).toBe(2);
    const tool = result.messages.find((m) => m.role === "tool");
    expect(tool?.content[0]).toMatchObject({ type: "tool_result", toolCallId: "c1" });
    expect(tool?.content[0]).not.toHaveProperty("isError");
  });

  it("renders invalid tool arguments as an isError result without throwing", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: 123 } }]),
        textResult("recovered"),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    expect(result.output).toBe("recovered");
    const tool = result.messages.find((m) => m.role === "tool");
    expect(tool?.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("isolates a throwing tool as an isError result", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [boom],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "boom", arguments: {} }]),
        textResult("after"),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    expect(result.output).toBe("after");
    const tool = result.messages.find((m) => m.role === "tool");
    expect(tool?.content[0]).toMatchObject({ type: "tool_result", isError: true });
    expect((tool?.content[0] as { content: { text: string }[] }).content[0]?.text).toContain("kaboom");
  });

  it("reports an unknown tool as an isError result", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "missing", arguments: {} }]),
        textResult("ok"),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    const tool = result.messages.find((m) => m.role === "tool");
    expect(tool?.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("executes parallel tool calls from one turn", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([
          { id: "c1", name: "echo", arguments: { value: "first" } },
          { id: "c2", name: "echo", arguments: { value: "second" } },
        ]),
        textResult("both done"),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => (m.content[0] as { toolCallId: string }).toolCallId)).toEqual(["c1", "c2"]);
  });

  it("aggregates usage across turns", async () => {
    const u: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }], u),
        textResult("done", u),
      ]),
    });
    const result = await runAgent(agent, { input: "go" });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it("throws MaxStepsExceededError when the model never stops calling tools", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
    });
    await expect(runAgent(agent, { input: "go", maxSteps: 2 })).rejects.toBeInstanceOf(MaxStepsExceededError);
  });

  it("throws CancelledError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("never")]) });
    await expect(runAgent(agent, { input: "go", signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
  });

  it("invokes lifecycle hooks in order", async () => {
    const order: string[] = [];
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }]),
        textResult("done"),
      ]),
      hooks: {
        onStart: () => void order.push("start"),
        onStep: ({ step }) => void order.push(`step${step}`),
        onToolCall: () => void order.push("toolCall"),
        onToolResult: () => void order.push("toolResult"),
        onFinish: () => void order.push("finish"),
      },
    });
    await runAgent(agent, { input: "go" });
    expect(order).toEqual(["start", "step1", "toolCall", "toolResult", "step2", "finish"]);
  });

  it("calls onError and rejects on a non-recoverable failure", async () => {
    const order: string[] = [];
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
      hooks: { onError: ({ error }) => void order.push(error.name) },
    });
    await expect(runAgent(agent, { input: "go", maxSteps: 1 })).rejects.toBeInstanceOf(MaxStepsExceededError);
    expect(order).toEqual(["MaxStepsExceededError"]);
  });
});

describe("runAgent — streaming", () => {
  it("yields token + tool lifecycle + run.finish, and resolves completed", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }]),
        textResult("streamed"),
      ]),
    });

    const events: RunEvent[] = [];
    const handle = runAgent(agent, { input: "go", stream: true });
    for await (const event of handle) events.push(event);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.start");
    expect(types).toContain("token");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types.at(-1)).toBe("run.finish");

    const finish = events.at(-1);
    expect(finish?.type === "run.finish" && finish.result.output).toBe("streamed");

    const result = await handle.completed;
    expect(result.output).toBe("streamed");
    expect(result.steps).toBe(2);
  });

  it("forwards events to the onEvent callback in buffered mode", async () => {
    const seen: string[] = [];
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("ok")]) });
    await runAgent(agent, { input: "go", onEvent: (e) => seen.push(e.type) });
    expect(seen[0]).toBe("run.start");
    expect(seen.at(-1)).toBe("run.finish");
  });
});
