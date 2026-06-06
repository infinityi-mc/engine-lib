/**
 * `runAgent` — the provider-native agent execution loop.
 *
 * Each step sends the conversation + the agent's tool schemas to the provider,
 * appends the assistant turn, and — if the model requested tools — validates
 * each call's arguments against its Phase-1 schema, dispatches the tools **in
 * parallel** with per-call error isolation, appends the results, and loops.
 * The loop ends when the model answers without tool calls, the step budget is
 * exhausted (`MaxStepsExceededError`), or the run is cancelled
 * (`CancelledError`).
 *
 * Buffered and streaming modes share one core async generator
 * ({@link executeAgent}); the buffered path drives it to completion, the
 * streaming path exposes it as a {@link RunHandle}.
 *
 * @module
 */

import type { AgentDefinition } from "../agent/types";
import { createToolRegistry } from "../agent/registry";
import type { ToolRegistry } from "../agent/registry";
import { handoffProviderTools, resolveHandoffTargets } from "../agent/handoff";
import type { InstructionContext } from "../agent/types";
import {
  AgentError,
  CancelledError,
  ExecutionError,
  MaxHandoffsExceededError,
  MaxStepsExceededError,
  type ProviderError,
} from "../errors";
import { system, user } from "../messages/factory";
import type { Message, TextPart } from "../messages/types";
import type { CompletionRequest, CompletionResult, FinishReason, Usage } from "../providers/types";
import { StreamAccumulator } from "../providers/stream";
import type { EngineContext } from "../runtime/types";
import { resolveContext } from "../context/providers";
import { applyContextWindow } from "../context/window";
import { toToolResultMessage } from "../tools/result";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";
import { createEventHub } from "../events/hub";
import type { EventHub } from "../events/types";
import { createRunTelemetry, SPAN_PROVIDER, SPAN_RUN, SPAN_TOOL } from "../events/telemetry";
import type { RunTelemetry } from "../events/telemetry";
import type { RunBridge, RunEvent, RunHandle, RunInput, RunOptions, RunResult } from "./types";
import { addUsage, emptyUsage } from "./usage";

/** Default cap on provider turns when {@link RunOptions.maxSteps} is omitted. */
export const DEFAULT_MAX_STEPS = 16;

/** Default cap on agent handoffs when {@link RunOptions.maxHandoffs} is omitted. */
export const DEFAULT_MAX_HANDOFFS = 8;

/** Coerce {@link RunInput} into messages. */
function normalizeInput(input?: RunInput): Message[] {
  if (input === undefined) return [];
  if (typeof input === "string") return [user(input)];
  if (Array.isArray(input)) return input;
  return [input];
}

/** Concatenate the text parts of a message. */
function extractText(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Wrap an unknown throw as an {@link AgentError} (passing AgentErrors through). */
function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ExecutionError(message, err instanceof Error ? { cause: err } : undefined);
}

/** Build the per-run {@link EngineContext} from options. */
function buildEngineContext(opts: RunOptions): EngineContext {
  return {
    ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

/** Merge the agent's default generation settings with per-run overrides into a request. */
function buildRequest(
  agent: AgentDefinition,
  opts: RunOptions,
  providerTools: CompletionRequest["tools"],
  messages: Message[],
): CompletionRequest {
  const gen = { ...agent.generation, ...opts.generation };
  return {
    messages,
    ...(gen.model !== undefined ? { model: gen.model } : {}),
    ...(providerTools !== undefined ? { tools: providerTools } : {}),
    ...(gen.toolChoice !== undefined ? { toolChoice: gen.toolChoice } : {}),
    ...(gen.temperature !== undefined ? { temperature: gen.temperature } : {}),
    ...(gen.topP !== undefined ? { topP: gen.topP } : {}),
    ...(gen.maxOutputTokens !== undefined ? { maxOutputTokens: gen.maxOutputTokens } : {}),
    ...(gen.stopSequences !== undefined ? { stopSequences: gen.stopSequences } : {}),
  };
}

/** Resolve static or dynamic instructions to a string. */
async function resolveInstructions(
  agent: AgentDefinition,
  engineCtx: EngineContext,
): Promise<string | undefined> {
  const instr = agent.instructions;
  if (instr === undefined) return undefined;
  if (typeof instr === "string") return instr;
  const ctx: InstructionContext = { ...engineCtx, agent };
  return instr(ctx);
}

/** Throw {@link CancelledError} if the signal is already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError("run cancelled");
}

/**
 * The execution core: drives the loop, yielding {@link RunEvent}s and returning
 * the final {@link RunResult}. Both run modes consume this generator.
 */
async function* executeAgent(
  agent: AgentDefinition,
  opts: RunOptions,
  tel: RunTelemetry,
): AsyncGenerator<RunEvent, RunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxHandoffs = opts.maxHandoffs ?? DEFAULT_MAX_HANDOFFS;
  const stream = opts.stream === true;
  const engineCtx = buildEngineContext(opts);

  /**
   * Per-agent run state: its tool registry, resolved handoff targets (keyed by
   * synthetic `transfer_to_<name>` tool name), and the toolset advertised to the
   * model (real tools + synthetic transfer tools).
   */
  interface ActiveState {
    readonly agent: AgentDefinition;
    readonly registry: ToolRegistry;
    readonly handoffs: ReadonlyMap<string, AgentDefinition>;
    readonly providerTools: CompletionRequest["tools"];
  }

  /** Build the run state for `agentDef`, failing fast on tool/handoff name clashes. */
  const activate = (agentDef: AgentDefinition): ActiveState => {
    const registry = createToolRegistry(agentDef.tools ?? []);
    const handoffs = resolveHandoffTargets(agentDef, opts.registry);
    for (const toolName of handoffs.keys()) {
      if (registry.has(toolName)) {
        throw new ExecutionError(
          `agent "${agentDef.name}" has a tool named "${toolName}" that collides with a handoff target`,
        );
      }
    }
    const advertised = [...registry.toProviderTools(), ...handoffProviderTools(handoffs)];
    return {
      agent: agentDef,
      registry,
      handoffs,
      providerTools: advertised.length > 0 ? advertised : undefined,
    };
  };

  // The active agent is mutable: a handoff swaps it (and its tools/instructions)
  // while the conversation continues. Starts as the agent passed to runAgent.
  let active = activate(agent);

  /** The outcome of one tool call: its result plus anything it bridged to the parent run. */
  interface ToolOutcome {
    readonly result: ToolResult;
    /** Nested events the tool forwarded (e.g. a sub-agent's run events). */
    readonly events: RunEvent[];
    /** Token usage the tool reported (e.g. a sub-agent's run usage). */
    readonly usage: Usage;
  }

  /** Run a single tool call with full error isolation (never throws). */
  const runOneTool = async (
    call: { id: string; name: string; arguments: unknown },
  ): Promise<ToolOutcome> => {
    const events: RunEvent[] = [];
    let usage = emptyUsage();
    const bridge: RunBridge = {
      emit: (event) => events.push(event),
      reportUsage: (u) => {
        usage = addUsage(usage, u);
      },
    };

    const tool: ToolDefinition | undefined = active.registry.get(call.name);
    if (tool === undefined) {
      return { result: { ok: false, error: `unknown tool: "${call.name}"` }, events, usage };
    }
    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return {
        result: { ok: false, error: `invalid arguments for "${call.name}": ${detail}` },
        events,
        usage,
      };
    }
    const toolCtx: ToolContext = {
      ...engineCtx,
      toolCallId: call.id,
      agentName: active.agent.name,
      run: bridge,
    };
    const span = tel.startSpan(SPAN_TOOL, { "tool.name": call.name, "tool.call_id": call.id });
    const startedAt = Date.now();
    try {
      const result = await tool.execute(parsed.data, toolCtx);
      span.setAttributes({ "tool.ok": result.ok });
      span.ok();
      return { result, events, usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.fail(message);
      return { result: { ok: false, error: message }, events, usage };
    } finally {
      span.end();
      tel.recordTool(
        { "tool.name": call.name, "agent.name": active.agent.name },
        Date.now() - startedAt,
      );
    }
  };

  // Hoisted above the try so the catch can stamp tokens-consumed-so-far onto
  // the error it throws.
  let usage = emptyUsage();

  try {
    throwIfAborted(opts.signal);
    yield { type: "run.start", agent: agent.name };

    // Assemble the conversation: instructions + injected context (rebuilt fresh
    // each run, never persisted), then prior history (from the session when set,
    // else opts.messages), then this run's new input. Kept inside the try so a
    // failing context provider or session-store load is wrapped as an AgentError,
    // surfaced as an `error` event, and routed through the onError hook.
    const instructions = await resolveInstructions(agent, engineCtx);
    const contextMessages = await resolveContext(opts.context, engineCtx);
    const prior =
      opts.session !== undefined ? await opts.session.messages() : (opts.messages ?? []);
    const inputMessages = normalizeInput(opts.input);

    const messages: Message[] = [];
    if (instructions !== undefined && instructions !== "") messages.push(system(instructions));
    messages.push(...contextMessages);
    messages.push(...prior);
    messages.push(...inputMessages);

    // Messages produced by *this* run (input + assistant/tool turns) — the only
    // ones appended back to the session. System/context/prior are excluded.
    const newMessages: Message[] = [...inputMessages];

    await active.agent.hooks?.onStart?.({ agent: active.agent, messages: [...messages] }, engineCtx);

    let finishReason: FinishReason = "stop";
    let finalMessage: Message = { role: "assistant", content: [] };
    let steps = 0;
    // Ordered trail of agents this run handed off to (Phase 7).
    const handoffTrail: string[] = [];

    while (steps < maxSteps) {
      throwIfAborted(opts.signal);
      steps++;

      const provider = active.agent.provider;
      const model =
        (opts.generation?.model ?? active.agent.generation?.model) ?? provider.defaultModel;
      // Trim a *view* of the history to fit the context window; the canonical
      // `messages` (persisted + returned) is never mutated.
      const requestMessages = await applyContextWindow(messages, opts.contextWindow, {
        provider,
        model,
        engine: engineCtx,
      });
      const req = buildRequest(active.agent, opts, active.providerTools, requestMessages);

      const useStreaming = stream && provider.capabilities.streaming;
      const providerSpan = tel.startSpan(SPAN_PROVIDER, {
        "provider.name": provider.name,
        "provider.model": model,
        "provider.mode": useStreaming ? "stream" : "complete",
        "agent.step": steps,
      });
      let result: CompletionResult;
      try {
        if (useStreaming) {
          const acc = new StreamAccumulator();
          let streamError: ProviderError | undefined;
          for await (const event of provider.stream(req, engineCtx)) {
            acc.push(event);
            if (event.type === "text_delta" && event.text !== "") {
              yield { type: "token", delta: event.text };
            } else if (event.type === "error") {
              streamError = event.error;
            }
          }
          if (streamError !== undefined) throw streamError;
          result = acc.result(model);
        } else {
          result = await provider.complete(req, engineCtx);
          if (stream) {
            const buffered = extractText(result.message);
            if (buffered !== "") yield { type: "token", delta: buffered };
          }
        }
        providerSpan.setAttributes({ "provider.finish_reason": result.finishReason });
        providerSpan.ok();
      } catch (err) {
        providerSpan.fail(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        providerSpan.end();
      }

      usage = addUsage(usage, result.usage);
      finishReason = result.finishReason;
      finalMessage = result.message;
      messages.push(result.message);
      newMessages.push(result.message);
      yield { type: "message", message: result.message };
      await active.agent.hooks?.onStep?.({ step: steps, result }, engineCtx);

      const calls = result.toolCalls;
      if (calls.length === 0) {
        const output = extractText(finalMessage);
        const runResult: RunResult = {
          output,
          finalMessage,
          messages: [...messages],
          finishReason,
          steps,
          usage,
          agent: active.agent.name,
          handoffs: [...handoffTrail],
        };
        await opts.session?.append(newMessages);
        yield { type: "run.finish", result: runResult };
        await active.agent.hooks?.onFinish?.({ output, usage }, engineCtx);
        return runResult;
      }

      // Partition this turn's calls against the *current* agent's handoff
      // targets: synthetic `transfer_to_<name>` calls switch the active agent;
      // everything else dispatches as a normal tool.
      const handoffTargets = active.handoffs;
      const regularCalls = calls.filter((call) => !handoffTargets.has(call.name));
      const handoffCalls = calls.filter((call) => handoffTargets.has(call.name));

      for (const call of calls) {
        yield { type: "tool.call", id: call.id, name: call.name, arguments: call.arguments };
        const tool = active.registry.get(call.name);
        if (tool !== undefined) await active.agent.hooks?.onToolCall?.({ call, tool }, engineCtx);
      }

      const settled = await Promise.all(
        regularCalls.map(async (call) => ({ call, outcome: await runOneTool(call) })),
      );

      // Fold each tool's bridged usage (e.g. a sub-agent's tokens) before the
      // abort check, so a cancellation detected here still accounts for tokens
      // already spent by the tools that just ran.
      for (const { outcome } of settled) usage = addUsage(usage, outcome.usage);
      throwIfAborted(opts.signal);

      for (const { call, outcome } of settled) {
        // Surface anything a tool bridged to the parent run: nested events
        // (e.g. a sub-agent's run events) before the tool's own result.
        for (const childEvent of outcome.events) yield childEvent;
        const toolResult = outcome.result;
        yield { type: "tool.result", id: call.id, name: call.name, result: toolResult };
        await active.agent.hooks?.onToolResult?.({ call, result: toolResult }, engineCtx);
      }
      for (const { call, outcome } of settled) {
        const message = toToolResultMessage(call.id, outcome.result);
        messages.push(message);
        newMessages.push(message);
        yield { type: "message", message };
      }

      // Process handoffs after this turn's real tools. Each transfer switches
      // the active agent while preserving the conversation history.
      for (const call of handoffCalls) {
        const target = handoffTargets.get(call.name);
        if (target === undefined) continue; // unreachable: filtered from handoffTargets

        if (handoffTrail.length >= maxHandoffs) {
          throw new MaxHandoffsExceededError(`exceeded max handoffs (${maxHandoffs})`, {
            handoffs: maxHandoffs,
          });
        }

        // Acknowledge the synthetic tool call so the assistant turn's tool_call
        // is satisfied for the provider, then announce and perform the switch.
        const ack: ToolResult = { ok: true, content: `Transferred to "${target.name}".` };
        const ackMessage = toToolResultMessage(call.id, ack);
        messages.push(ackMessage);
        newMessages.push(ackMessage);
        yield { type: "tool.result", id: call.id, name: call.name, result: ack };
        yield { type: "message", message: ackMessage };

        const from = active.agent;
        yield { type: "agent.handoff", from: from.name, to: target.name };
        await from.hooks?.onHandoff?.({ from, to: target }, engineCtx);

        active = activate(target);
        handoffTrail.push(target.name);

        // Inject the new agent's instructions as an additional system message so
        // it steers subsequent turns without rewriting the original system turn
        // (history-preserving). Like the initial instructions, this is derived
        // from agent config and not persisted to the session.
        const nextInstructions = await resolveInstructions(active.agent, engineCtx);
        if (nextInstructions !== undefined && nextInstructions !== "") {
          messages.push(system(nextInstructions));
        }
      }
    }

    throw new MaxStepsExceededError(`exceeded max steps (${maxSteps})`, { steps: maxSteps });
  } catch (err) {
    const agentError = toAgentError(err);
    // Surface the tokens consumed before the failure so callers (and a parent
    // run, via asTool) don't lose them. Don't clobber a usage already stamped
    // by a nested run.
    if (agentError.usage === undefined) agentError.usage = usage;
    yield { type: "error", error: agentError };
    try {
      await active.agent.hooks?.onError?.({ error: agentError }, engineCtx);
    } catch {
      // Preserve the run failure: onError observes errors, but should not replace them.
    }
    throw agentError;
  }
}

/** Token usage stamped on a failed run's error, or zero when unknown. */
function usageOfError(err: unknown): Usage {
  return err instanceof AgentError && err.usage !== undefined ? err.usage : emptyUsage();
}

/** Set the run span's outcome attributes from the final result. */
function runResultAttrs(result: RunResult): Record<string, string | number> {
  return {
    "agent.steps": result.steps,
    "agent.finish_reason": result.finishReason,
    "agent.usage.total_tokens": result.usage.totalTokens,
  };
}

/**
 * Drive the generator to completion, dispatching every event through `hub`.
 * The whole loop runs inside the `agent.run` span so provider/tool spans nest
 * underneath it, and run-level duration/usage metrics are recorded.
 */
async function driveToCompletion(
  gen: AsyncGenerator<RunEvent, RunResult>,
  hub: EventHub,
  tel: RunTelemetry,
  agentName: string,
): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const result = await tel.withSpan(SPAN_RUN, { "agent.name": agentName }, async (span) => {
      let next = await gen.next();
      while (!next.done) {
        await hub.emit(next.value);
        next = await gen.next();
      }
      span.setAttributes(runResultAttrs(next.value));
      span.ok();
      return next.value;
    });
    tel.recordRun({ "agent.name": agentName, "agent.outcome": "ok" }, Date.now() - startedAt, result.usage);
    return result;
  } catch (err) {
    tel.recordRun(
      { "agent.name": agentName, "agent.outcome": "error" },
      Date.now() - startedAt,
      usageOfError(err),
    );
    throw err;
  }
}

/** Wrap the generator as a {@link RunHandle} (async-iterable + `completed`). */
function makeHandle(
  gen: AsyncGenerator<RunEvent, RunResult>,
  hub: EventHub,
  tel: RunTelemetry,
  agentName: string,
): RunHandle {
  let resolveCompleted!: (result: RunResult) => void;
  let rejectCompleted!: (reason: unknown) => void;
  const completed = new Promise<RunResult>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // The run error is always propagated through the async-iterable (the generator
  // re-throws). Swallow it here so a consumer that only iterates — and never
  // awaits `completed` — doesn't trip an unhandled-rejection warning/crash.
  completed.catch(() => {});

  const span = tel.startSpan(SPAN_RUN, { "agent.name": agentName });
  const startedAt = Date.now();

  async function* iterate(): AsyncGenerator<RunEvent> {
    // Tracks whether the run reached a terminal state (finished or errored).
    // The `finally` uses it to close out the span and settle `completed` when a
    // consumer abandons the stream early (its `return()` skips both branches).
    let settled = false;
    try {
      let next = await gen.next();
      while (!next.done) {
        await hub.emit(next.value);
        yield next.value;
        next = await gen.next();
      }
      span.setAttributes(runResultAttrs(next.value));
      span.ok();
      settled = true;
      tel.recordRun(
        { "agent.name": agentName, "agent.outcome": "ok" },
        Date.now() - startedAt,
        next.value.usage,
      );
      resolveCompleted(next.value);
    } catch (err) {
      span.fail(err instanceof Error ? err.message : String(err));
      settled = true;
      tel.recordRun(
        { "agent.name": agentName, "agent.outcome": "error" },
        Date.now() - startedAt,
        usageOfError(err),
      );
      rejectCompleted(err);
      throw err;
    } finally {
      if (!settled) {
        // Consumer broke out of the iteration early. Propagate the cancellation
        // into the underlying generator, mark the run span cancelled, and settle
        // `completed` so neither the span nor the promise is left dangling.
        const cancelled = new CancelledError("run stream abandoned before completion");
        await gen.return(undefined as never).catch(() => {});
        span.fail(cancelled.message);
        tel.recordRun(
          { "agent.name": agentName, "agent.outcome": "incomplete" },
          Date.now() - startedAt,
          emptyUsage(),
        );
        rejectCompleted(cancelled);
      }
      span.end();
    }
  }

  const iterator = iterate();
  return {
    [Symbol.asyncIterator]: () => iterator,
    completed,
  };
}

/**
 * Assemble the {@link EventHub} for a run: the single {@link RunOptions.onEvent}
 * sink first, then any {@link RunOptions.subscribers}, with per-subscriber error
 * isolation logged via the run's logger.
 */
function buildEventHub(opts: RunOptions): EventHub {
  const logger = opts.logger ?? opts.telemetry?.log;
  return createEventHub({
    subscribers: [opts.onEvent, ...(opts.subscribers ?? [])],
    onSubscriberError: (error, event, index) => {
      logger?.warn("agent.run subscriber threw", {
        event: event.type,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/**
 * Run an agent to completion using the provider-native tool-calling loop.
 *
 * Buffered mode (default) resolves with a {@link RunResult}. Streaming mode
 * (`stream: true`) returns a {@link RunHandle} you can `for await` over for
 * {@link RunEvent}s, with `handle.completed` resolving to the final result.
 */
export function runAgent(
  agent: AgentDefinition,
  opts?: RunOptions & { stream?: false },
): Promise<RunResult>;
export function runAgent(
  agent: AgentDefinition,
  opts: RunOptions & { stream: true },
): RunHandle;
export function runAgent(
  agent: AgentDefinition,
  opts: RunOptions = {},
): Promise<RunResult> | RunHandle {
  const tel = createRunTelemetry(opts.telemetry);
  const hub = buildEventHub(opts);
  const gen = executeAgent(agent, opts, tel);
  if (opts.stream === true) return makeHandle(gen, hub, tel, agent.name);
  return driveToCompletion(gen, hub, tel, agent.name);
}
