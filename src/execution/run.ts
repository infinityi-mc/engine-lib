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

import { createHash } from "node:crypto";

import type { AgentDefinition } from "../agent/types";
import { createToolRegistry } from "../agent/registry";
import type { ToolRegistry } from "../agent/registry";
import { handoffProviderTools, resolveHandoffTargets } from "../agent/handoff";
import type { InstructionContext } from "../agent/types";
import {
  AgentError,
  BudgetExceededError,
  CancelledError,
  ExecutionError,
  MaxHandoffsExceededError,
  MaxStepsExceededError,
  SessionAgentMismatchError,
  SessionModelMismatchError,
  type ProviderError,
} from "../errors";
import { system, user } from "../messages/factory";
import type { Message, TextPart, ToolCallPart } from "../messages/types";
import type {
  CompletionRequest,
  CompletionResult,
  FinishReason,
  Usage,
} from "../providers/types";
import {
  RESUME_SCHEMA_VERSION,
  readResumeInfo,
  withResumeInfo,
} from "../session/resume";
import type { AppendResult, Session, SessionModelIdentity } from "../session/types";
import { StreamAccumulator } from "../providers/stream";
import type { EngineContext } from "../runtime/types";
import { resolveContext } from "../context/providers";
import { applyContextWindow } from "../context/window";
import { toFilteredToolResultMessage } from "../tools/result";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";
import { createEventHub } from "../events/hub";
import type { EventHub } from "../events/types";
import {
  createRunTelemetry,
  SPAN_PROVIDER,
  SPAN_RUN,
  SPAN_TOOL,
} from "../events/telemetry";
import type { RunTelemetry } from "../events/telemetry";
import type {
  AnyRunOptions,
  BufferedRunOptions,
  RunBridge,
  RunBridgeEvent,
  RunEvent,
  RunEventDraft,
  RunHandle,
  RunInput,
  RunOptions,
  RunResult,
  RunCheckpoint,
  StreamingRunOptions,
} from "./types";
import { addUsage, emptyUsage } from "./usage";
import { generateRunId } from "./run-id";
import type { ApprovalPendingCall, ApprovalRequest } from "../approval/types";
import { evaluateBudget } from "../resilience/budget";
import { isTokenRateLimiter } from "../resilience/rate-limit";
import { withProviderRetry } from "../resilience/retry";
import { filterMessagesText } from "../governance/filters";
import type { PolicyDecision } from "../governance/policy";
import { activeToolNames, compareAgentResume } from "../session/agent-compat";
import { isCasSessionStore, isVersionMismatch, withVersionRetry } from "../session-stores/index";

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

function toolCallParts(message: Message): ToolCallPart[] {
  return message.content.filter(
    (part): part is ToolCallPart => part.type === "tool_call",
  );
}

function toolResultIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_result") ids.add(part.toolCallId);
    }
  }
  return ids;
}

function trailingDanglingToolCalls(messages: readonly Message[]):
  | {
      readonly assistantIndex: number;
      readonly calls: readonly ToolCallPart[];
    }
  | undefined {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === "tool") index -= 1;
  if (index < 0) return undefined;
  const assistant = messages[index]!;
  if (assistant.role !== "assistant") return undefined;
  const calls = toolCallParts(assistant);
  if (calls.length === 0) return undefined;
  const results = toolResultIds(messages.slice(index + 1));
  const dangling = calls.filter((call) => !results.has(call.id));
  return dangling.length === 0
    ? undefined
    : { assistantIndex: index, calls: dangling };
}

function checkpointEvent(
  result: AppendResult,
  sessionId: string,
): RunEventDraft | undefined {
  return result.compacted === true
    ? {
        type: "session.compacted",
        sessionId,
        removed: result.removed ?? 0,
        summaryAdded: result.summaryAdded === true,
      }
    : undefined;
}

function stampRunEvent(runId: string, event: RunBridgeEvent): RunEvent {
  if (event.type === "agent.child") {
    const child = event.event as RunBridgeEvent;
    return {
      ...event,
      runId,
      // Preserve a pre-stamped child's own runId so nested sub-agent events
      // remain correlatable to their inner run; the wrapper itself still
      // carries the parent's runId for the "this came from parent X" link.
      event: hasRunId(child) ? child : stampRunEvent(runId, child),
    } as RunEvent;
  }
  return { ...event, runId } as RunEvent;
}

function hasRunId(event: RunBridgeEvent): event is RunEvent {
  return typeof (event as { readonly runId?: unknown }).runId === "string";
}

function resolveRunId(opts: RunOptions): string {
  if (opts.runId === undefined) return generateRunId();
  if (typeof opts.runId !== "string" || opts.runId.trim() === "") {
    throw new ExecutionError("runId must be a non-empty string");
  }
  return opts.runId;
}

async function* stampRunEvents(
  gen: AsyncGenerator<RunBridgeEvent, RunResult>,
  runId: string,
): AsyncGenerator<RunEvent, RunResult> {
  let completed = false;
  try {
    let next = await gen.next();
    while (!next.done) {
      yield stampRunEvent(runId, next.value);
      next = await gen.next();
    }
    completed = true;
    return next.value;
  } finally {
    if (!completed) {
      await gen.return(undefined as never).catch(() => {});
    }
  }
}

function argumentsDigest(value: unknown): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        typeof v === "bigint" ? String(v) : v,
      ) ?? "null",
    )
    .digest("hex");
  return `sha256:${hash}`;
}

function applyDecisionArguments(
  original: unknown,
  decision: PolicyDecision | { readonly allowed: true; readonly argumentsOverride?: unknown },
): unknown {
  if ("transformArguments" in decision) return decision.transformArguments;
  if ("argumentsOverride" in decision)
    return decision.argumentsOverride ?? original;
  return original;
}

function resolvedIdentity(
  agent: AgentDefinition,
  opts: RunOptions,
): SessionModelIdentity {
  const provider = agent.provider;
  return {
    model:
      opts.generation?.model ??
      agent.generation?.model ??
      provider.defaultModel,
    provider: provider.name,
  };
}

function identitiesMismatch(
  expected: SessionModelIdentity,
  actual: SessionModelIdentity,
): boolean {
  return (
    (expected.model !== undefined &&
      actual.model !== undefined &&
      expected.model !== actual.model) ||
    (expected.provider !== undefined &&
      actual.provider !== undefined &&
      expected.provider !== actual.provider)
  );
}

function checkpointFailure(error: unknown): ExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ExecutionError(
    `checkpoint callback failed: ${message}`,
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** Wrap an unknown throw as an {@link AgentError} (passing AgentErrors through). */
function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ExecutionError(
    message,
    err instanceof Error ? { cause: err } : undefined,
  );
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
    ...(gen.maxOutputTokens !== undefined
      ? { maxOutputTokens: gen.maxOutputTokens }
      : {}),
    ...(gen.stopSequences !== undefined
      ? { stopSequences: gen.stopSequences }
      : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendToSession(
  session: Session,
  messages: readonly Message[],
): Promise<AppendResult> {
  const store = session.store;
  if (isCasSessionStore(store)) {
    const result = await withVersionRetry(async (attempt) => {
      const version = await store
        .load(session.id)
        .then((s) => s?.version ?? 0);
      return store.appendIfVersion(session.id, messages, version);
    });
    if (isVersionMismatch(result)) {
      throw new ExecutionError(
        `session append failed due to version mismatch conflict (expected version: ${result.currentVersion})`,
      );
    }
    return result;
  }
  return session.append(messages);
}

function textLengthOfMessages(messages: readonly Message[]): number {

  let length = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "text") length += part.text.length;
      if (part.type === "tool_result") {
        for (const textPart of part.content) length += textPart.text.length;
      }
    }
  }
  return length;
}

function estimateInputTokens(req: CompletionRequest): number {
  return Math.ceil(textLengthOfMessages(req.messages) / 4);
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted)
    return Promise.reject(new CancelledError("run cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError("run cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function acquireProviderRateLimit(
  opts: RunOptions,
  req: CompletionRequest,
): Promise<number | undefined> {
  const limiter = opts.rateLimiter;
  if (limiter === undefined) return undefined;
  const startedAt = Date.now();
  const acquire = isTokenRateLimiter(limiter)
    ? limiter.acquireForTokens(
        estimateInputTokens(req),
        req.maxOutputTokens ?? 0,
        { signal: opts.signal },
      )
    : limiter.acquire(1, { signal: opts.signal });
  await waitWithAbort(acquire, opts.signal);
  return Date.now() - startedAt;
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
  runId: string,
): AsyncGenerator<RunBridgeEvent, RunResult> {
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
    const advertised = [
      ...registry.toProviderTools(),
      ...handoffProviderTools(handoffs),
    ];
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

  const activeToolNames = (): readonly string[] =>
    active.registry
      .list()
      .map((tool) => tool.name)
      .toSorted();

  /** The outcome of one tool call: its result plus anything it bridged to the parent run. */
  interface ToolOutcome {
    readonly result: ToolResult;
    /** Nested events the tool forwarded (e.g. a sub-agent's run events). */
    readonly events: RunBridgeEvent[];
    /** Token usage the tool reported (e.g. a sub-agent's run usage). */
    readonly usage: Usage;
    /** Cancellation requested by a tool after it had already emitted bridge events. */
    readonly cancelled?: CancelledError;
  }

  /** Run a single tool call with full error isolation (never throws). */
  const runOneTool = async (
    call: {
      id: string;
      name: string;
      arguments: unknown;
    },
    approvalFailure?: ToolResult,
  ): Promise<ToolOutcome> => {
    const events: RunBridgeEvent[] = [];
    let usage = emptyUsage();
    const bridge: RunBridge = {
      emit: (event) => events.push(event),
      reportUsage: (u) => {
        usage = addUsage(usage, u);
      },
    };

    const tool: ToolDefinition | undefined = active.registry.get(call.name);
    if (tool === undefined) {
      return {
        result: { ok: false, error: `unknown tool: "${call.name}"` },
        events,
        usage,
      };
    }
    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return {
        result: {
          ok: false,
          error: `invalid arguments for "${call.name}": ${detail}`,
        },
        events,
        usage,
      };
    }
    if (approvalFailure !== undefined) {
      return { result: approvalFailure, events, usage };
    }
    const toolCtx: ToolContext = {
      ...engineCtx,
      toolCallId: call.id,
      agentName: active.agent.name,
      ...(opts.humanInput !== undefined ? { humanInput: opts.humanInput } : {}),
      ...(opts.session?.tenantId !== undefined
        ? { tenantId: opts.session.tenantId }
        : {}),
      ...(opts.principal !== undefined ? { principal: opts.principal } : {}),
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      run: bridge,
    };
    const span = tel.startSpan(SPAN_TOOL, {
      "run.id": runId,
      "tool.name": call.name,
      "tool.call_id": call.id,
    });
    const startedAt = Date.now();
    try {
      const result = await tool.execute(parsed.data, toolCtx);
      span.setAttributes({ "tool.ok": result.ok });
      span.ok();
      return { result, events, usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.fail(message);
      return err instanceof CancelledError && opts.signal?.aborted
        ? {
            result: { ok: false, error: message },
            events,
            usage,
            cancelled: err,
          }
        : { result: { ok: false, error: message }, events, usage };
    } finally {
      span.end();
      tel.recordTool(
        { "tool.name": call.name, "agent.name": active.agent.name },
        Date.now() - startedAt,
      );
    }
  };

  const evaluateApprovals = async (
    calls: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }[],
    messageSnapshot: readonly Message[],
    forcedApprovalRequired: ReadonlySet<string> = new Set(),
  ): Promise<{
    readonly failures: ReadonlyMap<string, ToolResult>;
    readonly events: readonly RunEventDraft[];
    readonly approvedArgs: ReadonlyMap<string, unknown>;
  }> => {
    const policy = opts.approval;
    if (calls.length === 0) {
      return { failures: new Map(), events: [], approvedArgs: new Map() };
    }

    const failures = new Map<string, ToolResult>();
    const events: RunEventDraft[] = [];
    const approvedArgs = new Map<string, unknown>();

    const pendingCalls: ApprovalPendingCall[] = [];
    const parsedById = new Map<string, unknown>();
    const messages = messageSnapshot;

    for (const call of calls) {
      const tool = active.registry.get(call.name);
      if (tool === undefined) continue;
      const parsed = tool.parameters.safeParse(call.arguments);
      if (!parsed.success) continue;
      parsedById.set(call.id, parsed.data);
      pendingCalls.push({
        id: call.id,
        name: call.name,
        arguments: parsed.data,
      });
    }

    for (const call of calls) {
      if (!parsedById.has(call.id)) continue;
      const parsedArguments = parsedById.get(call.id);

      const requiresApprovalByPolicy = forcedApprovalRequired.has(call.id);

      if (policy === undefined) {
        if (requiresApprovalByPolicy) {
          const reason = `tool "${call.name}" requires approval but no approval policy is configured`;
          events.push({
            type: "tool.approval_decided",
            id: call.id,
            name: call.name,
            approved: false,
            reason,
          });
          failures.set(call.id, { ok: false, error: reason });
        } else {
          approvedArgs.set(call.id, parsedArguments);
        }
        continue;
      }

      const request: ApprovalRequest = {
        toolCallId: call.id,
        name: call.name,
        arguments: parsedArguments,
        agentName: active.agent.name,
        messages,
        pendingCalls,
        ...(opts.session !== undefined ? { sessionId: opts.session.id } : {}),
      };

      let requiresApproval = false;
      if (requiresApprovalByPolicy) {
        requiresApproval = true;
      } else {
        try {
          throwIfAborted(opts.signal);
          requiresApproval = await waitWithAbort(
            Promise.resolve(policy.requiresApproval(request, engineCtx)),
            opts.signal,
          );
        } catch (error) {
          if (error instanceof CancelledError && opts.signal?.aborted)
            throw error;
          const reason = messageOf(error);
          events.push({
            type: "tool.approval_decided",
            id: call.id,
            name: call.name,
            approved: false,
            reason,
          });
          failures.set(call.id, { ok: false, error: reason });
          continue;
        }
      }

      if (!requiresApproval) {
        approvedArgs.set(call.id, parsedArguments);
        continue;
      }

      events.push({
        type: "tool.approval_requested",
        id: call.id,
        name: call.name,
        argumentsDigest: argumentsDigest(parsedArguments),
      });

      try {
        throwIfAborted(opts.signal);
        const decision = await waitWithAbort(
          Promise.resolve(policy.decide(request, engineCtx)),
          opts.signal,
        );
        events.push({
          type: "tool.approval_decided",
          id: call.id,
          name: call.name,
          approved: decision.approved === true,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        });
        if (decision.approved !== true) {
          failures.set(call.id, {
            ok: false,
            error: decision.reason ?? `tool "${call.name}" was not approved`,
          });
        } else {
          approvedArgs.set(call.id, parsedArguments);
        }
      } catch (error) {
        if (error instanceof CancelledError && opts.signal?.aborted)
          throw error;
        const reason = messageOf(error);
        events.push({
          type: "tool.approval_decided",
          id: call.id,
          name: call.name,
          approved: false,
          reason,
        });
        failures.set(call.id, { ok: false, error: reason });
      }
    }

    return { failures, events, approvedArgs };
  };

  const evaluatePolicies = async (
    calls: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }[],
    messageSnapshot: readonly Message[],
    inboundOverrides: ReadonlyMap<string, unknown> = new Map(),
  ): Promise<{
    readonly failures: ReadonlyMap<string, ToolResult>;
    readonly events: readonly RunEventDraft[];
    readonly transformedArgs: ReadonlyMap<string, unknown>;
    readonly approvalRequired: ReadonlySet<string>;
  }> => {
    const policy = opts.policy;
    if (policy === undefined || calls.length === 0) {
      return {
        failures: new Map(),
        events: [],
        transformedArgs: new Map(),
        approvalRequired: new Set(),
      };
    }

    const failures = new Map<string, ToolResult>();
    const events: RunEventDraft[] = [];
    const transformedArgs = new Map<string, unknown>();
    const approvalRequired = new Set<string>();

    for (const call of calls) {
      const tool = active.registry.get(call.name);
      if (tool === undefined) continue;
      const parsed = tool.parameters.safeParse(call.arguments);
      if (!parsed.success) continue;
      const inbound = inboundOverrides.get(call.id) ?? parsed.data;
      const validatedInbound = tool.parameters.safeParse(inbound);
      const evaluatedArgs = validatedInbound.success ? validatedInbound.data : inbound;
      try {
        const decision = await Promise.resolve(
          policy.evaluate(
            {
              tool: call.name,
              operation: call.name.startsWith("http_")
                ? "network"
                : call.name.includes("command")
                  ? "exec"
                  : call.name.startsWith("write") || call.name.startsWith("edit")
                    ? "write"
                    : call.name.startsWith("delete")
                      ? "delete"
                      : "read",
              target:
                typeof evaluatedArgs === "object" &&
                evaluatedArgs !== null &&
                "url" in evaluatedArgs &&
                typeof (evaluatedArgs as { readonly url?: unknown }).url === "string"
                  ? ((evaluatedArgs as { readonly url: string }).url)
                  : typeof evaluatedArgs === "object" &&
                      evaluatedArgs !== null &&
                      "command" in evaluatedArgs &&
                      typeof (evaluatedArgs as { readonly command?: unknown }).command ===
                        "string"
                    ? ((evaluatedArgs as { readonly command: string }).command)
                    : typeof evaluatedArgs === "object" &&
                        evaluatedArgs !== null &&
                        "path" in evaluatedArgs &&
                        typeof (evaluatedArgs as { readonly path?: unknown }).path ===
                          "string"
                      ? ((evaluatedArgs as { readonly path: string }).path)
                      : call.name,
              arguments: evaluatedArgs,
            },
            {
              agentName: active.agent.name,
              ...(opts.session !== undefined ? { sessionId: opts.session.id } : {}),
              ...(opts.session?.tenantId !== undefined
                ? { tenantId: opts.session.tenantId }
                : {}),
              ...(opts.principal !== undefined ? { principal: opts.principal } : {}),
              messages: messageSnapshot,
            },
          ),
        );
        events.push({
          type: "policy.decision",
          id: call.id,
          name: call.name,
          allowed: decision.allowed,
          ...(decision.allowed ? {} : { reason: decision.reason }),
          ...("requiresApproval" in decision && decision.requiresApproval
            ? { requiresApproval: true }
            : {}),
          ...("transformArguments" in decision ? { transformed: true } : {}),
          argumentsDigest: argumentsDigest(evaluatedArgs),
        });
        if (!decision.allowed) {
          failures.set(call.id, { ok: false, error: decision.reason });
          continue;
        }
        const nextArgs = applyDecisionArguments(evaluatedArgs, decision);
        transformedArgs.set(call.id, nextArgs);
        if ("requiresApproval" in decision && decision.requiresApproval) {
          approvalRequired.add(call.id);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        events.push({
          type: "policy.decision",
          id: call.id,
          name: call.name,
          allowed: false,
          reason,
          argumentsDigest: argumentsDigest(evaluatedArgs),
        });
        failures.set(call.id, { ok: false, error: reason });
      }
    }

    return { failures, events, transformedArgs, approvalRequired };
  };

  const evaluateAuthorizations = async (
    calls: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }[],
    messageSnapshot: readonly Message[],
  ): Promise<{
    readonly failures: ReadonlyMap<string, ToolResult>;
    readonly events: readonly RunEventDraft[];
    readonly transformedArgs: ReadonlyMap<string, unknown>;
  }> => {
    const authorizer = opts.authorizer;
    if (authorizer === undefined || calls.length === 0) {
      return { failures: new Map(), events: [], transformedArgs: new Map() };
    }
    const failures = new Map<string, ToolResult>();
    const events: RunEventDraft[] = [];
    const transformedArgs = new Map<string, unknown>();
    for (const call of calls) {
      const tool = active.registry.get(call.name);
      if (tool === undefined) continue;
      const parsed = tool.parameters.safeParse(call.arguments);
      if (!parsed.success) continue;
      try {
        const decision = await Promise.resolve(
          authorizer.authorize(
            { name: call.name, arguments: parsed.data },
            {
              name: call.name,
              arguments: parsed.data,
              agentName: active.agent.name,
              ...(opts.session !== undefined ? { sessionId: opts.session.id } : {}),
              ...(opts.session?.tenantId !== undefined
                ? { tenantId: opts.session.tenantId }
                : {}),
              ...(opts.principal !== undefined ? { principal: opts.principal } : {}),
              ...(opts.roles !== undefined ? { roles: opts.roles } : {}),
              messages: messageSnapshot,
            },
          ),
        );
        events.push({
          type: "tool.authorization_decided",
          id: call.id,
          name: call.name,
          allowed: decision.allowed,
          ...(decision.allowed ? {} : { reason: decision.reason }),
          argumentsDigest: argumentsDigest(parsed.data),
        });
        if (!decision.allowed) {
          failures.set(call.id, { ok: false, error: decision.reason });
          continue;
        }
        transformedArgs.set(call.id, applyDecisionArguments(parsed.data, decision));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        events.push({
          type: "tool.authorization_decided",
          id: call.id,
          name: call.name,
          allowed: false,
          reason,
          argumentsDigest: argumentsDigest(parsed.data),
        });
        failures.set(call.id, { ok: false, error: reason });
      }
    }
    return { failures, events, transformedArgs };
  };

  // the error it throws.
  let usage = emptyUsage();
  const checkpointMode = opts.checkpoint?.mode === "step";
  let interruptedMarked = false;
  let startingTotalUsage = emptyUsage();
  let loadedResume = undefined as ReturnType<typeof readResumeInfo>;
  const warnedBudgetFields = new Set<string>();

  const usageForBudget = (snapshot: Usage): Usage =>
    opts.budget?.scope === "session"
      ? addUsage(startingTotalUsage, snapshot)
      : snapshot;

  const evaluateRunBudget = (snapshot: Usage): readonly RunEventDraft[] => {
    const budget = opts.budget;
    if (budget === undefined) return [];
    const breaches = evaluateBudget(budget, usageForBudget(snapshot));
    if (breaches.length === 0) return [];
    if ((budget.onBudgetExceeded ?? "stop") === "stop") {
      const breach = breaches[0]!;
      throw new BudgetExceededError(
        `run budget exceeded: ${breach.field} used ${breach.used} > ${breach.limit}`,
        {
          field: breach.field,
          limit: breach.limit,
          usage: usageForBudget(snapshot),
        },
      );
    }
    const events: RunEventDraft[] = [];
    for (const breach of breaches) {
      if (warnedBudgetFields.has(breach.field)) continue;
      warnedBudgetFields.add(breach.field);
      events.push({
        type: "budget.warning",
        field: breach.field,
        used: breach.used,
        limit: breach.limit,
      });
    }
    return events;
  };

  const writeResumeStatus = async (
    status: "completed" | "failed" | "interrupted",
    usageSnapshot: Usage,
  ): Promise<void> => {
    const session = opts.session;
    if (session === undefined) return;
    const currentMetadata = (await session.getMetadata()) ?? {};
    const identity = resolvedIdentity(active.agent, opts);
    await session.setMetadata(
      withResumeInfo(currentMetadata, {
        schemaVersion: RESUME_SCHEMA_VERSION,
        agentName: active.agent.name,
        ...(identity.model !== undefined ? { model: identity.model } : {}),
        ...(identity.provider !== undefined
          ? { provider: identity.provider }
          : {}),
        ...(active.agent.version !== undefined
          ? { agentVersion: active.agent.version }
          : {}),
        toolNames: activeToolNames(),
        lastActiveAt: new Date().toISOString(),
        lastRunStatus: status,
        totalUsage: addUsage(startingTotalUsage, usageSnapshot),
      }),
    );
  };

  const runCheckpointCallback = async (
    step: number,
    newMessages: readonly Message[],
    pending: readonly ToolCallPart[] = [],
  ): Promise<void> => {
    const callback = opts.checkpoint?.onCheckpoint;
    if (callback === undefined) return;
    const checkpoint: RunCheckpoint = {
      runId,
      ...(opts.session !== undefined ? { sessionId: opts.session.id } : {}),
      agent: active.agent.name,
      step,
      newMessages: [...newMessages],
      pending: [...pending],
      status: "running",
    };
    try {
      await callback(checkpoint);
    } catch (error) {
      throw checkpointFailure(error);
    }
  };

  try {
    throwIfAborted(opts.signal);
    yield { type: "run.start", agent: agent.name };

    // Assemble the conversation: instructions + injected context (rebuilt fresh
    // each run, never persisted), then prior history (from the session when set,
    // else opts.messages), then this run's new input. Kept inside the try so a
    // failing context provider or session-store load is wrapped as an AgentError,
    // surfaced as an `error` event, and routed through the onError hook.
    const instructions = await resolveInstructions(agent, engineCtx);
    const session = opts.session;
    let prior =
      session !== undefined ? await session.messages() : (opts.messages ?? []);
    const sessionMetadata =
      session !== undefined ? await session.getMetadata() : undefined;
    loadedResume = readResumeInfo(sessionMetadata);
    startingTotalUsage = loadedResume?.totalUsage ?? emptyUsage();

    if (session !== undefined) {
      const expectedModel = session.expectedModel ?? loadedResume?.model;
      const expectedProvider =
        session.expectedProvider ?? loadedResume?.provider;
      const expected: SessionModelIdentity = {
        ...(expectedModel !== undefined ? { model: expectedModel } : {}),
        ...(expectedProvider !== undefined
          ? { provider: expectedProvider }
          : {}),
      };
      const actual = resolvedIdentity(active.agent, opts);
      if (identitiesMismatch(expected, actual)) {
        const policy = opts.modelCompatibility ?? "warn";
        if (policy === "error") {
          throw new SessionModelMismatchError(
            "session model/provider mismatch",
            {
              expected,
              actual,
            },
          );
        }
        if (policy === "warn") {
          engineCtx.logger?.warn("session model/provider mismatch", {
            sessionId: session.id,
            expected,
            actual,
          });
          yield {
            type: "custom",
            name: "session.model_mismatch",
            data: { sessionId: session.id, expected, actual },
          };
        }
      }
      const agentMismatch = compareAgentResume(loadedResume, active.agent);
      if (agentMismatch !== undefined) {
        const policy = opts.agentCompatibility ?? "warn";
        if (policy === "error") {
          throw new SessionAgentMismatchError(
            "session agent/tool mismatch",
            agentMismatch,
          );
        }
        if (policy === "warn") {
          engineCtx.logger?.warn("session agent/tool mismatch", {
            sessionId: session.id,
            expected: agentMismatch.expected,
            actual: agentMismatch.actual,
          });
          yield {
            type: "custom",
            name: "session.agent_mismatch",
            data: {
              sessionId: session.id,
              expected: agentMismatch.expected,
              actual: agentMismatch.actual,
            },
          };
        }
      }
    }

    if (session !== undefined && opts.resume !== false) {
      const dangling = trailingDanglingToolCalls(prior);
      if (dangling !== undefined) {
        const resumeOptions =
          typeof opts.resume === "object" ? opts.resume : undefined;
        const strategy = resumeOptions?.danglingToolCalls ?? "synthesize-error";
        let reconciled = 0;

        if (strategy === "drop") {
          reconciled = dangling.calls.length;
          prior = prior.slice(0, dangling.assistantIndex);
        } else if (strategy === "synthesize-error") {
          const synthesized: Message[] = [];
          for (const call of dangling.calls) {
            synthesized.push(
              await toFilteredToolResultMessage(
                call.id,
                {
                  ok: false,
                  error: `Prior run was interrupted before tool "${call.name}" (${call.id}) completed.`,
                },
                opts.filters,
                {
                  agentName: active.agent.name,
                  sessionId: session.id,
                },
              ),
            );
          }
          if (synthesized.length > 0) {
            const appendResult = await appendToSession(session, synthesized);
            const event = checkpointEvent(appendResult, session.id);
            if (event !== undefined) yield event;
            prior = [...prior, ...synthesized];
          }
          reconciled = synthesized.length;
        } else {
          const toolMessages: Message[] = [];
          for (const call of dangling.calls) {
            yield {
              type: "tool.call",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            };
            const tool = active.registry.get(call.name);
            if (tool !== undefined)
              await active.agent.hooks?.onToolCall?.({ call, tool }, engineCtx);
            const outcome = await runOneTool(call);
            usage = addUsage(usage, outcome.usage);
            for (const event of evaluateRunBudget(usage)) yield event;
            for (const childEvent of outcome.events) yield childEvent;
            yield {
              type: "tool.result",
              id: call.id,
              name: call.name,
              result: outcome.result,
            };
            await active.agent.hooks?.onToolResult?.(
              { call, result: outcome.result },
              engineCtx,
            );
            const message = await toFilteredToolResultMessage(
              call.id,
              outcome.result,
              opts.filters,
              { agentName: active.agent.name, sessionId: session.id },
            );
            toolMessages.push(message);
            yield { type: "message", message };
          }
          if (toolMessages.length > 0) {
            const appendResult = await appendToSession(session, toolMessages);
            const event = checkpointEvent(appendResult, session.id);
            if (event !== undefined) yield event;
            prior = [...prior, ...toolMessages];
          }
          reconciled = toolMessages.length;
        }

        yield {
          type: "session.resumed",
          sessionId: session.id,
          messageCount: prior.length,
          reconciledToolCalls: reconciled,
          ...(loadedResume !== undefined ? { resume: loadedResume } : {}),
        };
      }
    }

    const inputMessages = normalizeInput(opts.input);
    if (checkpointMode && session !== undefined && inputMessages.length > 0) {
      const appendResult = await appendToSession(session, inputMessages);
      const event = checkpointEvent(appendResult, session.id);
      if (event !== undefined) yield event;
    }
    const contextMessages = await resolveContext(opts.context, engineCtx, {
      agentName: agent.name,
      ...(instructions !== undefined ? { instructions } : {}),
      input: inputMessages,
      prior,
      messages: [...prior, ...inputMessages],
      ...(opts.contextWindow !== undefined
        ? { contextWindow: opts.contextWindow }
        : {}),
    });

    const messages: Message[] = [];
    if (instructions !== undefined && instructions !== "")
      messages.push(system(instructions));
    messages.push(...contextMessages);
    messages.push(...prior);
    messages.push(...inputMessages);

    // Messages produced by *this* run (input + assistant/tool turns) — the only
    // ones appended back to the session. System/context/prior are excluded.
    const newMessages: Message[] = [...inputMessages];

    await active.agent.hooks?.onStart?.(
      { agent: active.agent, messages: [...messages] },
      engineCtx,
    );

    let finishReason: FinishReason = "stop";
    let finalMessage: Message = { role: "assistant", content: [] };
    let steps = 0;
    // Ordered trail of agents this run handed off to (Phase 7).
    const handoffTrail: string[] = [];

    while (steps < maxSteps) {
      throwIfAborted(opts.signal);
      for (const event of evaluateRunBudget(usage)) yield event;
      steps++;

      const provider = active.agent.provider;
      const model =
        opts.generation?.model ??
        active.agent.generation?.model ??
        provider.defaultModel;
      // Trim a *view* of the history to fit the context window; the canonical
      // `messages` (persisted + returned) is never mutated.
      const requestMessages = await applyContextWindow(
        messages,
        opts.contextWindow,
        {
          provider,
          model,
          engine: engineCtx,
        },
      );
      const filteredRequestMessages =
        opts.filters?.providerInput !== undefined
          ? await filterMessagesText(
              requestMessages,
              opts.filters.providerInput,
              {
                stage: "provider-input",
                agentName: active.agent.name,
                ...(opts.session !== undefined
                  ? { sessionId: opts.session.id }
                  : {}),
              },
              opts.filters.onError,
            )
          : requestMessages;
      const req = buildRequest(
        active.agent,
        opts,
        active.providerTools,
        filteredRequestMessages,
      );
      const waitedMs = await acquireProviderRateLimit(opts, req);
      if (waitedMs !== undefined && waitedMs > 0) {
        yield { type: "rate_limit.wait", waitedMs };
      }

      const useStreaming = stream && provider.capabilities.streaming;
      const providerSpan = tel.startSpan(SPAN_PROVIDER, {
        "run.id": runId,
        "provider.name": provider.name,
        "provider.model": model,
        "provider.mode": useStreaming ? "stream" : "complete",
        "agent.step": steps,
      });
      let result: CompletionResult;
      const retryEvents: RunEventDraft[] = [];
      const collectProviderCall = async (): Promise<CompletionResult> => {
        if (useStreaming) {
          const acc = new StreamAccumulator();
          let streamError: ProviderError | undefined;
          for await (const event of provider.stream(req, engineCtx)) {
            acc.push(event);
            if (event.type === "error") {
              streamError = event.error;
            }
          }
          if (streamError !== undefined) throw streamError;
          return acc.result(model);
        }
        return provider.complete(req, engineCtx);
      };
      try {
        if (opts.retry === undefined && useStreaming) {
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
          result =
            opts.retry === undefined
              ? await provider.complete(req, engineCtx)
              : await withProviderRetry(
                  collectProviderCall,
                  opts.retry,
                  engineCtx,
                  (event) => {
                    retryEvents.push({ type: "provider.retry", ...event });
                  },
                );
        }
        for (const event of retryEvents) yield event;
        if (stream && (!useStreaming || opts.retry !== undefined)) {
          const buffered = extractText(result.message);
          if (buffered !== "") yield { type: "token", delta: buffered };
        }
        providerSpan.setAttributes({
          "provider.finish_reason": result.finishReason,
          "provider.retry_count": retryEvents.filter(
            (event) => event.type === "provider.retry",
          ).length,
        });
        providerSpan.ok();
      } catch (err) {
        for (const event of retryEvents) yield event;
        providerSpan.fail(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        providerSpan.end();
      }

      usage = addUsage(usage, result.usage);
      for (const event of evaluateRunBudget(usage)) yield event;
      finishReason = result.finishReason;
      finalMessage = result.message;
      messages.push(result.message);
      newMessages.push(result.message);
      yield { type: "message", message: result.message };
      await active.agent.hooks?.onStep?.({ step: steps, result }, engineCtx);

      if (checkpointMode && opts.session !== undefined) {
        const appendResult = await appendToSession(opts.session, [result.message]);
        const event = checkpointEvent(appendResult, opts.session.id);
        if (event !== undefined) yield event;
        if (!interruptedMarked) {
          await writeResumeStatus("interrupted", usage);
          interruptedMarked = true;
        }
      }

      const calls = result.toolCalls;
      if (calls.length === 0) {
        await runCheckpointCallback(steps, newMessages);
        const output = extractText(finalMessage);
        const runResult: RunResult = {
          runId,
          output,
          finalMessage,
          messages: [...messages],
          finishReason,
          steps,
          usage,
          agent: active.agent.name,
          handoffs: [...handoffTrail],
        };
        if (!checkpointMode && opts.session !== undefined) {
          const appendResult = await appendToSession(opts.session, newMessages);
          const event = checkpointEvent(appendResult, opts.session.id);
          if (event !== undefined) yield event;
        }
        await writeResumeStatus("completed", usage);
        yield { type: "run.finish", result: runResult };
        await active.agent.hooks?.onFinish?.({ output, usage }, engineCtx);
        return runResult;
      }

      // Partition this turn's calls against the *current* agent's handoff
      // targets: synthetic `transfer_to_<name>` calls switch the active agent;
      // everything else dispatches as a normal tool.
      const handoffTargets = active.handoffs;
      const regularCalls = calls.filter(
        (call) => !handoffTargets.has(call.name),
      );
      const handoffCalls = calls.filter((call) =>
        handoffTargets.has(call.name),
      );

      for (const call of calls) {
        yield {
          type: "tool.call",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
        const tool = active.registry.get(call.name);
        if (tool !== undefined)
          await active.agent.hooks?.onToolCall?.({ call, tool }, engineCtx);
      }

      const authorization = await evaluateAuthorizations(regularCalls, messages);
      for (const event of authorization.events) yield event;
      const policy = await evaluatePolicies(regularCalls, messages, authorization.transformedArgs);
      for (const event of policy.events) yield event;
      const approvalInput = regularCalls.map((call) => ({
        ...call,
        arguments:
          policy.transformedArgs.get(call.id) ??
          authorization.transformedArgs.get(call.id) ??
          call.arguments,
      }));
      const approval = await evaluateApprovals(approvalInput, messages, policy.approvalRequired);
      for (const event of approval.events) yield event;

      const settled = await Promise.all(
        regularCalls.map(async (call) => {
          const denied =
            authorization.failures.get(call.id) ??
            policy.failures.get(call.id) ??
            approval.failures.get(call.id);
          const nextArgs =
            approval.approvedArgs.get(call.id) ??
            policy.transformedArgs.get(call.id) ??
            authorization.transformedArgs.get(call.id) ??
            call.arguments;
          return {
            call:
              denied === undefined ? { ...call, arguments: nextArgs } : call,
            outcome: await runOneTool(
              denied === undefined ? { ...call, arguments: nextArgs } : call,
              denied,
            ),
          };
        }),
      );

      // Fold each tool's bridged usage (e.g. a sub-agent's tokens) before the
      // abort check, so a cancellation detected here still accounts for tokens
      // already spent by the tools that just ran.
      for (const { outcome } of settled) usage = addUsage(usage, outcome.usage);
      const cancelled = settled.find(
        ({ outcome }) => outcome.cancelled !== undefined,
      )?.outcome.cancelled;
      if (cancelled !== undefined || opts.signal?.aborted) {
        for (const { outcome } of settled) {
          for (const childEvent of outcome.events) yield childEvent;
        }
        if (cancelled !== undefined) throw cancelled;
        throwIfAborted(opts.signal);
      }
      for (const event of evaluateRunBudget(usage)) yield event;
      throwIfAborted(opts.signal);

      for (const { call, outcome } of settled) {
        // Surface anything a tool bridged to the parent run: nested events
        // (e.g. a sub-agent's run events) before the tool's own result.
        for (const childEvent of outcome.events) yield childEvent;
        const toolResult = outcome.result;
        yield {
          type: "tool.result",
          id: call.id,
          name: call.name,
          result: toolResult,
        };
        await active.agent.hooks?.onToolResult?.(
          { call, result: toolResult },
          engineCtx,
        );
      }
      const stepToolMessages: Message[] = [];
      for (const { call, outcome } of settled) {
        const message = await toFilteredToolResultMessage(
          call.id,
          outcome.result,
          opts.filters,
          {
            agentName: active.agent.name,
            ...(opts.session !== undefined
              ? { sessionId: opts.session.id }
              : {}),
          },
        );
        messages.push(message);
        newMessages.push(message);
        stepToolMessages.push(message);
        yield { type: "message", message };
      }

      // Process handoffs after this turn's real tools. Each transfer switches
      // the active agent while preserving the conversation history.
      for (const call of handoffCalls) {
        const target = handoffTargets.get(call.name);
        if (target === undefined) continue; // unreachable: filtered from handoffTargets

        if (handoffTrail.length >= maxHandoffs) {
          throw new MaxHandoffsExceededError(
            `exceeded max handoffs (${maxHandoffs})`,
            {
              handoffs: maxHandoffs,
            },
          );
        }

        // Acknowledge the synthetic tool call so the assistant turn's tool_call
        // is satisfied for the provider, then announce and perform the switch.
        const ack: ToolResult = {
          ok: true,
          content: `Transferred to "${target.name}".`,
        };
        const ackMessage = await toFilteredToolResultMessage(
          call.id,
          ack,
          opts.filters,
          {
            agentName: active.agent.name,
            ...(opts.session !== undefined
              ? { sessionId: opts.session.id }
              : {}),
          },
        );
        messages.push(ackMessage);
        newMessages.push(ackMessage);
        stepToolMessages.push(ackMessage);
        yield {
          type: "tool.result",
          id: call.id,
          name: call.name,
          result: ack,
        };
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
        const nextInstructions = await resolveInstructions(
          active.agent,
          engineCtx,
        );
        if (nextInstructions !== undefined && nextInstructions !== "") {
          messages.push(system(nextInstructions));
        }
      }

      if (
        checkpointMode &&
        opts.session !== undefined &&
        stepToolMessages.length > 0
      ) {
        const appendResult = await appendToSession(opts.session, stepToolMessages);
        const event = checkpointEvent(appendResult, opts.session.id);
        if (event !== undefined) yield event;
      }
      await runCheckpointCallback(steps, newMessages);
    }

    throw new MaxStepsExceededError(`exceeded max steps (${maxSteps})`, {
      steps: maxSteps,
    });
  } catch (err) {
    const agentError = toAgentError(err);
    // Surface the tokens consumed before the failure so callers (and a parent
    // run, via asTool) don't lose them. Don't clobber a usage already stamped
    // by a nested run.
    if (agentError.usage === undefined) agentError.usage = usage;
    await writeResumeStatus("failed", usage).catch(() => {});
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
  return err instanceof AgentError && err.usage !== undefined
    ? err.usage
    : emptyUsage();
}

/** Set the run span's outcome attributes from the final result. */
function runResultAttrs(result: RunResult): Record<string, string | number> {
  return {
    "run.id": result.runId,
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
  runId: string,
): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const result = await tel.withSpan(
      SPAN_RUN,
      { "run.id": runId, "agent.name": agentName },
      async (span) => {
        let next = await gen.next();
        while (!next.done) {
          await hub.emit(next.value);
          next = await gen.next();
        }
        span.setAttributes(runResultAttrs(next.value));
        span.ok();
        return next.value;
      },
    );
    tel.recordRun(
      { "run.id": runId, "agent.name": agentName, "agent.outcome": "ok" },
      Date.now() - startedAt,
      result.usage,
    );
    return result;
  } catch (err) {
    tel.recordRun(
      { "run.id": runId, "agent.name": agentName, "agent.outcome": "error" },
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
  runId: string,
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

  const span = tel.startSpan(SPAN_RUN, {
    "run.id": runId,
    "agent.name": agentName,
  });
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
        { "run.id": runId, "agent.name": agentName, "agent.outcome": "ok" },
        Date.now() - startedAt,
        next.value.usage,
      );
      resolveCompleted(next.value);
    } catch (err) {
      span.fail(err instanceof Error ? err.message : String(err));
      settled = true;
      tel.recordRun(
        { "run.id": runId, "agent.name": agentName, "agent.outcome": "error" },
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
        const cancelled = new CancelledError(
          "run stream abandoned before completion",
        );
        await gen.return(undefined as never).catch(() => {});
        span.fail(cancelled.message);
        tel.recordRun(
          {
            "run.id": runId,
            "agent.name": agentName,
            "agent.outcome": "incomplete",
          },
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
 * Buffered mode (default, or `stream: false`) resolves with a {@link RunResult}.
 * Streaming mode (`stream: true`) returns a {@link RunHandle} you can
 * `for await` over for {@link RunEvent}s, with `handle.completed` resolving to
 * the final result. When `stream` is a non-literal boolean, the return type is
 * `Promise<RunResult> | RunHandle`.
 */
export function runAgent(
  agent: AgentDefinition,
  opts?: BufferedRunOptions,
): Promise<RunResult>;
export function runAgent(
  agent: AgentDefinition,
  opts: StreamingRunOptions,
): RunHandle;
export function runAgent(
  agent: AgentDefinition,
  opts: AnyRunOptions,
): Promise<RunResult> | RunHandle;
export function runAgent(
  agent: AgentDefinition,
  opts: RunOptions = {},
): Promise<RunResult> | RunHandle {
  const runId = resolveRunId(opts);
  const tel = createRunTelemetry(opts.telemetry);
  const hub = buildEventHub(opts);
  const gen = stampRunEvents(executeAgent(agent, opts, tel, runId), runId);
  if (opts.stream === true) return makeHandle(gen, hub, tel, agent.name, runId);
  return driveToCompletion(gen, hub, tel, agent.name, runId);
}
