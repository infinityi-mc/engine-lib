import { describe, expect, it } from "bun:test";

import { defineAgent, defineTool } from "../src/agent/index";
import { staticContext } from "../src/context/index";
import {
  AgentError,
  CancelledError,
  ContextWindowError,
  ExecutionError,
  MaxStepsExceededError,
  SessionModelMismatchError,
} from "../src/errors";
import { runAgent } from "../src/execution/index";
import type { RunEvent } from "../src/execution/index";
import { assistant, user } from "../src/messages/index";
import type { Message } from "../src/messages/types";
import type { CompletionResult, ToolCall, Usage } from "../src/providers/types";
import { s } from "../src/schema/index";
import { createSession, InMemorySessionStore, readResumeInfo, withResumeInfo } from "../src/session/index";
import { withSessionStoreHooks } from "../src/session-stores/index";
import { mockProvider } from "../src/testing/index";

function textOf(message: Message): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

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
    expect(result.runId).toMatch(/^run_/);
    expect(result.steps).toBe(1);
    expect(result.finishReason).toBe("stop");
    // history: user input + assistant answer
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("uses one generated runId across events and result", async () => {
    const events: RunEvent[] = [];
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("hello")]) });

    const result = await runAgent(agent, { input: "hi", onEvent: (event) => events.push(event) });

    expect(result.runId).toMatch(/^run_/);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([result.runId]));
    expect(events[0]).toMatchObject({ type: "run.start", runId: result.runId });
    expect(events.at(-1)).toMatchObject({ type: "run.finish", runId: result.runId });
  });

  it("uses a host-supplied runId verbatim across events and result", async () => {
    const events: RunEvent[] = [];
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("hello")]) });

    const result = await runAgent(agent, {
      input: "hi",
      runId: "req-123",
      onEvent: (event) => events.push(event),
    });

    expect(result.runId).toBe("req-123");
    expect(events.every((event) => event.runId === "req-123")).toBe(true);
  });

  it("rejects an empty host-supplied runId", async () => {
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("hello")]) });

    expect(() => runAgent(agent, { input: "hi", runId: "" })).toThrow("runId must be a non-empty string");
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

  it("stamps nested draft child events emitted through the run bridge", async () => {
    const nested = defineTool({
      name: "nested",
      parameters: s.object({}),
      execute: (_args, ctx) => {
        ctx.run?.emit({
          type: "agent.child",
          agent: "child",
          depth: 1,
          event: { type: "custom", name: "child.custom", data: {} } as never,
        });
        return { ok: true, content: "nested" };
      },
    });
    const agent = defineAgent({
      name: "a",
      tools: [nested],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "nested", arguments: {} }]),
        textResult("done"),
      ]),
    });
    const events: RunEvent[] = [];

    const result = await runAgent(agent, { input: "go", onEvent: (event) => events.push(event) });

    const child = events.find((event): event is Extract<RunEvent, { type: "agent.child" }> => event.type === "agent.child");
    expect(child?.runId).toBe(result.runId);
    expect(child?.event.runId).toBe(result.runId);
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

  it("preserves the original failure if onError throws", async () => {
    const order: string[] = [];
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
      hooks: {
        onError: ({ error }) => {
          order.push(error.name);
          throw new Error("hook failed");
        },
      },
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

  it("surfaces a run error through iteration and rejects completed", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
    });
    const handle = runAgent(agent, { input: "go", stream: true, maxSteps: 1 });

    const events: RunEvent[] = [];
    let iterationError: unknown;
    try {
      for await (const event of handle) events.push(event);
    } catch (err) {
      iterationError = err;
    }
    expect(iterationError).toBeInstanceOf(MaxStepsExceededError);
    expect(events.map((e) => e.type)).toContain("error");
    await expect(handle.completed).rejects.toBeInstanceOf(MaxStepsExceededError);
  });

  it("closes the provider stream when iteration stops early", async () => {
    let providerClosed = false;
    const provider = {
      ...mockProvider({ result: textResult("unused") }),
      async *stream() {
        try {
          yield { type: "message_start", model: "mock-model" } as const;
          yield { type: "text_delta", text: "partial" } as const;
          await new Promise<never>(() => {});
        } finally {
          providerClosed = true;
        }
      },
    };
    const agent = defineAgent({ name: "a", provider });
    const handle = runAgent(agent, { input: "go", stream: true });

    for await (const event of handle) {
      if (event.type === "token") break;
    }

    await expect(handle.completed).rejects.toBeInstanceOf(CancelledError);
    expect(providerClosed).toBe(true);
  });

  it("does not crash when a failing stream is iterated without awaiting completed", async () => {
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
    });
    const handle = runAgent(agent, { input: "go", stream: true, maxSteps: 1 });
    // Intentionally never touch `handle.completed`.
    await expect((async () => {
      for await (const _ of handle) void _;
    })()).rejects.toBeInstanceOf(MaxStepsExceededError);
    // Give the microtask queue a tick; an unhandled rejection would surface here.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("forwards events to the onEvent callback in buffered mode", async () => {
    const seen: string[] = [];
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("ok")]) });
    await runAgent(agent, { input: "go", onEvent: (e) => seen.push(e.type) });
    expect(seen[0]).toBe("run.start");
    expect(seen.at(-1)).toBe("run.finish");
  });
});

describe("runAgent — sessions & context (Phase 5)", () => {
  it("reads session history before the run and persists only new messages after", async () => {
    const session = createSession({ id: "s1", messages: [user("prior question")] });
    let seenRequest: Message[] = [];
    const agent = defineAgent({
      name: "a",
      provider: mockProvider({
        result: () => textResult("answer"),
        onRequest: (req) => {
          seenRequest = [...req.messages];
        },
      }),
    });

    const result = await runAgent(agent, { input: "new question", session });

    // The provider saw prior history + new input.
    expect(seenRequest.map((m) => textOf(m))).toEqual(["prior question", "new question"]);
    // The session now holds prior + new input + assistant answer (no system/context dupes).
    const persisted = await session.messages();
    expect(persisted.map((m) => `${m.role}:${textOf(m)}`)).toEqual([
      "user:prior question",
      "user:new question",
      "assistant:answer",
    ]);
    expect(result.output).toBe("answer");
  });

  it("does not persist system or injected-context messages to the session", async () => {
    const session = createSession({ id: "s2" });
    const agent = defineAgent({
      name: "a",
      instructions: "be terse",
      provider: scriptedProvider([textResult("ok")]),
    });
    await runAgent(agent, { input: "hi", session, context: [staticContext("secret fact")] });
    const persisted = await session.messages();
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted.some((m) => textOf(m).includes("secret fact"))).toBe(false);
  });

  it("resumes a conversation across runs by reusing the same session", async () => {
    const session = createSession({ id: "tab" });
    const agent = defineAgent({ name: "a", provider: scriptedProvider([textResult("r")]) });
    await runAgent(agent, { input: "first", session });
    const second = await runAgent(agent, { input: "second", session });
    // second run's full history includes both turns
    expect(second.messages.map((m) => `${m.role}:${textOf(m)}`)).toEqual([
      "user:first",
      "assistant:r",
      "user:second",
      "assistant:r",
    ]);
  });

  it("injects context as a system message visible to the provider", async () => {
    let seenRequest: Message[] = [];
    const agent = defineAgent({
      name: "a",
      instructions: "instructions",
      provider: mockProvider({
        result: () => textResult("ok"),
        onRequest: (req) => {
          seenRequest = [...req.messages];
        },
      }),
    });
    await runAgent(agent, { input: "hi", context: [staticContext("injected fact")] });
    // [system(instructions), system(context), user(input)]
    expect(seenRequest.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(textOf(seenRequest[1]!)).toContain("injected fact");
  });

  it("trims the request via contextWindow but keeps full history in RunResult", async () => {
    let seenRequest: Message[] = [];
    const agent = defineAgent({
      name: "a",
      provider: mockProvider({
        result: () => textResult("final"),
        onRequest: (req) => {
          seenRequest = [...req.messages];
        },
      }),
    });
    const prior = [user("old-1"), assistant("old-2"), user("old-3")];
    const result = await runAgent(agent, {
      input: "newest",
      messages: prior,
      contextWindow: { maxTokens: 1, countTokens: (m) => m.length },
    });
    // request trimmed to a single (most recent) message
    expect(seenRequest).toHaveLength(1);
    expect(textOf(seenRequest[0]!)).toBe("newest");
    // canonical history untouched: prior (3) + input (1) + assistant (1)
    expect(result.messages).toHaveLength(5);
  });

  it("surfaces ContextWindowError as an error event and rethrows", async () => {
    const seen: string[] = [];
    const agent = defineAgent({
      name: "a",
      instructions: "a very long system prompt that cannot be dropped",
      provider: scriptedProvider([textResult("ok")]),
    });
    await expect(
      runAgent(agent, {
        input: "hi",
        onEvent: (e) => seen.push(e.type),
        contextWindow: { maxTokens: 0, countTokens: (m) => m.length },
      }),
    ).rejects.toBeInstanceOf(ContextWindowError);
    expect(seen).toContain("error");
  });

  it("routes a failing context provider through the error event + onError hook", async () => {
    const seen: string[] = [];
    let onErrorSeen = false;
    const agent = defineAgent({
      name: "a",
      provider: scriptedProvider([textResult("ok")]),
      hooks: { onError: () => { onErrorSeen = true; } },
    });
    const exploding = {
      name: "boom",
      resolve: () => {
        throw new Error("context blew up");
      },
    };
    await expect(
      runAgent(agent, { input: "hi", context: [exploding], onEvent: (e) => seen.push(e.type) }),
    ).rejects.toBeInstanceOf(AgentError);
    expect(seen).toContain("error");
    expect(onErrorSeen).toBe(true);
  });

  it("does not persist to the session when the run fails", async () => {
    const session = createSession({ id: "fail" });
    const agent = defineAgent({
      name: "a",
      tools: [echo],
      provider: scriptedProvider([toolCallResult([{ id: "c1", name: "echo", arguments: { value: "x" } }])]),
    });
    await expect(runAgent(agent, { input: "go", session, maxSteps: 1 })).rejects.toBeInstanceOf(
      MaxStepsExceededError,
    );
    expect(await session.messages()).toHaveLength(0);
  });

  it("writes typed resume metadata without clobbering host metadata", async () => {
    const session = createSession({ id: "resume-info", metadata: { host: true } });
    const usage: Usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    const agent = defineAgent({
      name: "resume-agent",
      version: "1.2.3",
      tools: [echo],
      provider: scriptedProvider([textResult("ok", usage)]),
    });

    await runAgent(agent, { input: "hi", session });

    const metadata = await session.getMetadata();
    expect(metadata?.host).toBe(true);
    const resume = readResumeInfo(metadata);
    expect(resume).toMatchObject({
      schemaVersion: 2,
      agentName: "resume-agent",
      agentVersion: "1.2.3",
      toolNames: ["echo"],
      model: "mock-model",
      provider: "mock",
      lastRunStatus: "completed",
      totalUsage: usage,
    });
    expect(typeof resume?.lastActiveAt).toBe("string");
  });

  it("persists each completed step in checkpoint step mode without duplicating final messages", async () => {
    const makeAgent = () => defineAgent({
      name: "checkpoint-agent",
      tools: [echo],
      provider: scriptedProvider([
        toolCallResult([{ id: "c1", name: "echo", arguments: { value: "yo" } }]),
        textResult("done"),
      ]),
    });
    const normalSession = createSession({ id: "normal" });
    const checkpointSession = createSession({ id: "checkpoint" });

    await runAgent(makeAgent(), { input: "go", session: normalSession });
    await runAgent(makeAgent(), {
      input: "go",
      session: checkpointSession,
      checkpoint: { mode: "step" },
    });

    expect(await checkpointSession.messages()).toEqual(await normalSession.messages());
    expect(readResumeInfo(await checkpointSession.getMetadata())?.lastRunStatus).toBe("completed");
  });

  it("marks checkpointed sessions interrupted before terminal completion", async () => {
    const session = createSession({ id: "interrupt-marker" });
    const seen: string[] = [];
    const agent = defineAgent({ name: "checkpoint-agent", provider: scriptedProvider([textResult("done")]) });

    await runAgent(agent, {
      input: "go",
      session,
      checkpoint: {
        mode: "step",
        onCheckpoint: async () => {
          const resume = readResumeInfo(await session.getMetadata());
          if (resume !== undefined) seen.push(resume.lastRunStatus);
        },
      },
    });

    expect(seen).toEqual(["interrupted"]);
    expect(readResumeInfo(await session.getMetadata())?.lastRunStatus).toBe("completed");
  });

  it("fails the run when onCheckpoint rejects and emits an error event", async () => {
    const seen: string[] = [];
    const agent = defineAgent({ name: "checkpoint-agent", provider: scriptedProvider([textResult("done")]) });

    await expect(
      runAgent(agent, {
        input: "go",
        checkpoint: {
          onCheckpoint: () => {
            throw new Error("checkpoint lost");
          },
        },
        onEvent: (event) => seen.push(event.type),
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
    expect(seen).toContain("error");
  });

  it("stamps checkpoints with the runId", async () => {
    let checkpointRunId: string | undefined;
    const agent = defineAgent({ name: "checkpoint-agent", provider: scriptedProvider([textResult("done")]) });

    const result = await runAgent(agent, {
      input: "go",
      runId: "checkpoint-run",
      checkpoint: {
        onCheckpoint: (checkpoint) => {
          checkpointRunId = checkpoint.runId;
        },
      },
    });

    expect(result.runId).toBe("checkpoint-run");
    expect(checkpointRunId).toBe("checkpoint-run");
  });

  it("synthesizes an error tool result for dangling calls on resume by default", async () => {
    const store = new InMemorySessionStore();
    await store.save({
      id: "dangling",
      messages: [
        user("go"),
        assistant([{ type: "tool_call", id: "c1", name: "echo", arguments: { value: "yo" } }]),
      ],
      metadata: withResumeInfo({ host: true }, {
        schemaVersion: 1,
        agentName: "resume-agent",
        model: "mock-model",
        provider: "mock",
        lastActiveAt: new Date().toISOString(),
        lastRunStatus: "interrupted",
      }),
    });

    let toolRuns = 0;
    let request: Message[] = [];
    let resumedBeforeRequest = false;
    let providerSawResume = false;
    const guardedEcho = defineTool({
      name: "echo",
      parameters: s.object({ value: s.string() }),
      execute: ({ value }) => {
        toolRuns += 1;
        return { ok: true, content: value };
      },
    });
    const agent = defineAgent({
      name: "resume-agent",
      tools: [guardedEcho],
      provider: mockProvider({
        result: () => textResult("after"),
        onRequest: (req) => {
          providerSawResume = resumedBeforeRequest;
          request = req.messages;
        },
      }),
    });

    const events: RunEvent[] = [];
    await runAgent(agent, {
      session: createSession({ id: "dangling", store }),
      onEvent: (event) => {
        events.push(event);
        if (event.type === "session.resumed") resumedBeforeRequest = true;
      },
    });

    expect(toolRuns).toBe(0);
    expect(providerSawResume).toBe(true);
    expect(events.filter((event) => event.type === "session.resumed")).toHaveLength(1);
    expect(request.some((message) => message.content.some((part) => (
      part.type === "tool_result" && part.toolCallId === "c1" && part.isError === true
    )))).toBe(true);
  });

  it("can reexecute dangling calls on resume when requested", async () => {
    const store = new InMemorySessionStore();
    await store.save({
      id: "reexecute",
      messages: [
        user("go"),
        assistant([{ type: "tool_call", id: "c1", name: "echo", arguments: { value: "yo" } }]),
      ],
      metadata: withResumeInfo(undefined, {
        schemaVersion: 1,
        agentName: "resume-agent",
        model: "mock-model",
        provider: "mock",
        lastActiveAt: new Date().toISOString(),
        lastRunStatus: "interrupted",
      }),
    });

    let toolRuns = 0;
    const countingEcho = defineTool({
      name: "echo",
      parameters: s.object({ value: s.string() }),
      execute: ({ value }) => {
        toolRuns += 1;
        return { ok: true, content: value };
      },
    });
    const agent = defineAgent({
      name: "resume-agent",
      tools: [countingEcho],
      provider: scriptedProvider([textResult("after")]),
    });

    await runAgent(agent, {
      session: createSession({ id: "reexecute", store }),
      resume: { danglingToolCalls: "reexecute" },
    });

    expect(toolRuns).toBe(1);
    expect((await store.load("reexecute"))?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("enforces and warns on model compatibility policies", async () => {
    const metadata = withResumeInfo(undefined, {
      schemaVersion: 1,
      agentName: "old",
      model: "gpt-4",
      provider: "mock",
      lastActiveAt: new Date().toISOString(),
      lastRunStatus: "completed",
    });

    const errorStore = new InMemorySessionStore();
    await errorStore.save({ id: "mismatch-error", messages: [user("prior")], metadata });
    let providerCalls = 0;
    const errorAgent = defineAgent({
      name: "new",
      provider: mockProvider({
        defaultModel: "claude-3-opus",
        onRequest: () => {
          providerCalls += 1;
        },
      }),
    });
    await expect(
      runAgent(errorAgent, {
        session: createSession({ id: "mismatch-error", store: errorStore }),
        modelCompatibility: "error",
      }),
    ).rejects.toBeInstanceOf(SessionModelMismatchError);
    expect(providerCalls).toBe(0);

    const warnStore = new InMemorySessionStore();
    await warnStore.save({ id: "mismatch-warn", messages: [user("prior")], metadata });
    const events: RunEvent[] = [];
    await runAgent(errorAgent, {
      session: createSession({ id: "mismatch-warn", store: warnStore }),
      onEvent: (event) => events.push(event),
    });
    expect(events.some((event) => event.type === "custom" && event.name === "session.model_mismatch")).toBe(true);
  });

  it("emits session.compacted when a session append triggers store compaction", async () => {
    const store = withSessionStoreHooks(new InMemorySessionStore(), {
      compactor: {
        shouldCompact: (state) => state.messages.length > 1,
        compact: (state) => ({
          state: { id: state.id, messages: state.messages.slice(-1), metadata: state.metadata },
          archive: { messages: state.messages.slice(0, -1), reason: "test" },
        }),
      },
    });
    const session = createSession({ id: "compact-run", store });
    const events: RunEvent[] = [];
    const agent = defineAgent({ name: "compact-agent", provider: scriptedProvider([textResult("done")]) });

    await runAgent(agent, { input: "go", session, onEvent: (event) => events.push(event) });

    const compacted = events.find((event) => event.type === "session.compacted");
    expect(compacted?.type === "session.compacted" && compacted.removed).toBeGreaterThan(0);
  });
});
