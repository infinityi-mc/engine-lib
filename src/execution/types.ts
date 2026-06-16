/**
 * Types for the agent execution flow.
 *
 * {@link runAgent} drives the provider-native tool-calling loop. It runs in two
 * shapes that share one core: *buffered* (returns a {@link RunResult}) and
 * *streaming* (returns a {@link RunHandle} — an async-iterable of
 * {@link RunEvent}s plus a `completed` promise). Both modes also feed
 * {@link RunOptions.onEvent} and {@link RunOptions.subscribers}.
 *
 * `RunEvent["type"]` values are part of the public contract. Consumers should
 * handle unknown future variants defensively if they want minor-version
 * compatibility with newly added events.
 *
 * @module
 */

import type { AgentError } from "../errors";
import type { Message } from "../messages/types";
import type { FinishReason, Usage } from "../providers/types";
import type { Logger, TelemetryHandle } from "../runtime/types";
import type { GenerationSettings } from "../agent/types";
import type { AgentRegistry } from "../agent/agent-registry";
import type { ContextProvider, ContextWindowOptions } from "../context/types";
import type { SessionResumeInfo } from "../session/resume";
import type { Session } from "../session/types";
import type { ToolResult } from "../tools/types";
import type { RunSubscriber } from "../events/types";
import type { ToolCallPart } from "../messages/types";
import type { ApprovalPolicy, HumanInputGateway } from "../approval/types";
import type { ContentFilterConfig } from "../governance/filters";
import type { PolicyEngine } from "../governance/policy";
import type { RateLimiter, RetryPolicy, RunBudget } from "../resilience/index";
import type { ToolAuthorizer } from "../authorization/authorizer";

/** New input for a run: raw text (→ a user message), a single message, or several. */
export type RunInput = string | Message | Message[];

/**
 * A single event emitted over the course of a run.
 *
 * Ordering guarantees:
 *
 * - Every run starts with `run.start`.
 * - Provider assistant turns are emitted as `message` events.
 * - Streaming text is emitted as `token` before the assistant `message` that
 *   contains the accumulated text.
 * - Tool calls emit `tool.call`, any governance events for that call
 *   (`policy.decision`, `tool.authorization_decided`,
 *   `tool.approval_requested`, `tool.approval_decided`), then `tool.result`,
 *   then the corresponding tool-result `message`.
 * - Successful runs end with `run.finish`; failed runs emit `error` and then
 *   reject/throw the same `AgentError`.
 * - `agent.child` wraps events forwarded from sub-agent tools, and
 *   `agent.handoff` marks a control transfer between agents.
 */
export type RunEventDraft =
  | { readonly type: "run.start"; readonly agent: string }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "token"; readonly delta: string }
  | {
      readonly type: "tool.call";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: "tool.result";
      readonly id: string;
      readonly name: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: "tool.approval_requested";
      readonly id: string;
      readonly name: string;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "tool.authorization_decided";
      readonly id: string;
      readonly name: string;
      readonly allowed: boolean;
      readonly reason?: string;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "policy.decision";
      readonly id: string;
      readonly name: string;
      readonly allowed: boolean;
      readonly reason?: string;
      readonly requiresApproval?: boolean;
      readonly transformed?: boolean;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "tool.approval_decided";
      readonly id: string;
      readonly name: string;
      readonly approved: boolean;
      readonly reason?: string;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "human.input_requested";
      readonly requestId: string;
      readonly question: string;
      readonly context?: string;
    }
  | {
      readonly type: "human.input_provided";
      readonly requestId: string;
      readonly cancelled: boolean;
    }
  | {
      readonly type: "budget.warning";
      readonly field: "totalTokens" | "inputTokens" | "outputTokens";
      readonly used: number;
      readonly limit: number;
    }
  | {
      readonly type: "provider.retry";
      readonly attempt: number;
      readonly delayMs: number;
      readonly status?: number;
    }
  | { readonly type: "rate_limit.wait"; readonly waitedMs: number }
  | { readonly type: "run.finish"; readonly result: RunResult }
  | { readonly type: "error"; readonly error: AgentError }
  /**
   * An event from a nested child run (e.g. a sub-agent invoked through
   * {@link RunBridge}). `agent` is the child's name and `depth` is its nesting
   * level relative to this run (1 for a direct child). Parent subscribers that
   * don't care about nesting can ignore this variant; those that do can recurse
   * into `event`.
   */
  | {
      readonly type: "agent.child";
      readonly agent: string;
      readonly depth: number;
      readonly event: RunEvent;
    }
  /**
   * The active agent handed the run off to another agent (Phase 7). `from` and
   * `to` are agent names. Emitted at the switch point; the message history is
   * preserved across the handoff.
   */
  | {
      readonly type: "agent.handoff";
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly type: "session.resumed";
      readonly sessionId: string;
      readonly messageCount: number;
      readonly reconciledToolCalls: number;
      readonly resume?: SessionResumeInfo;
    }
  | {
      readonly type: "session.compacted";
      readonly sessionId: string;
      readonly removed: number;
      readonly summaryAdded: boolean;
    }
  | {
      readonly type: "session.expired";
      readonly sessionId: string;
      readonly reason: "ttl" | "idle" | "purged";
    }
  /**
   * An extension event emitted by an optional module or a custom tool through
   * {@link RunBridge.emit}. `name` namespaces the event (e.g. `"shell.exec.start"`)
   * and `data` is a JSON-serializable payload. The core loop never produces this
   * variant; it is the stable seam for surfacing module-specific metadata (policy
   * decisions, approvals, streamed output) onto the same subscriber/auditing
   * stream as built-in events. Subscribers that don't recognize a `name` should
   * ignore it.
   */
  | {
      readonly type: "custom";
      readonly name: string;
      readonly data: Record<string, unknown>;
    };

export type WithRunId<T> = T extends { readonly type: string }
  ? T & { readonly runId: string }
  : never;

/** A public run event as delivered to subscribers, stamped with this invocation's run id. */
export type RunEvent = WithRunId<RunEventDraft>;

/** Event shape accepted from run bridges before the parent run stamps its id. */
export type RunBridgeEvent = RunEventDraft | RunEvent;

/**
 * A handle the run loop hands to a tool so it can participate in its parent run:
 * forward nested {@link RunEvent}s onto the parent's event stream and fold
 * nested token {@link Usage} into the parent run's aggregate. Used by
 * sub-agent-as-tool (`asTool`) to propagate a child run's events and usage
 * upward. Tools that ignore it behave exactly as before.
 */
export interface RunBridge {
  /** Forward a nested event onto the parent run's event stream. */
  emit(event: RunBridgeEvent): void;
  /** Add token usage from nested work into the parent run's running total. */
  reportUsage(usage: Usage): void;
  /** Parent run step cap, when explicitly configured. */
  readonly maxSteps?: number;
  /** Parent run handoff cap, when explicitly configured. */
  readonly maxHandoffs?: number;
}

/** Checkpointing behavior for durable mid-run progress. */
export interface CheckpointPolicy {
  readonly mode?: "step" | "off";
  onCheckpoint?(checkpoint: RunCheckpoint): void | Promise<void>;
}

/** Snapshot reported after a completed provider step. */
export interface RunCheckpoint {
  /** Correlates the checkpoint with the run that produced it. */
  readonly runId: string;
  readonly sessionId?: string;
  readonly agent: string;
  readonly step: number;
  readonly newMessages: readonly Message[];
  readonly pending: readonly ToolCallPart[];
  readonly status: "running";
}

/** Resume reconciliation behavior for interrupted tool-call turns. */
export interface ResumeOptions {
  readonly danglingToolCalls?: "synthesize-error" | "reexecute" | "drop";
}

/** Options for a single {@link runAgent} call. */
export interface RunOptions {
  /** Per-invocation correlation id. Generated when omitted; host-supplied values are used verbatim. */
  readonly runId?: string;
  /** New input for this run. */
  readonly input?: RunInput;
  /** Prior conversation prepended before `input`. Ignored when `session` is set (history comes from the session). */
  readonly messages?: Message[];
  /** Durable conversation: history is read before the run and new messages appended after it. */
  readonly session?: Session;
  /** Durable mid-run checkpointing. Defaults to off. */
  readonly checkpoint?: CheckpointPolicy;
  /** Resume reconciliation policy. Defaults to true with synthesized tool errors. */
  readonly resume?: ResumeOptions | boolean;
  /** Model/provider compatibility policy for resumed sessions. Defaults to "warn". */
  readonly modelCompatibility?: "warn" | "error" | "ignore";
  /** Agent version/tool-set compatibility policy for resumed sessions. Defaults to "warn". */
  readonly agentCompatibility?: "warn" | "error" | "ignore";
  /** Context providers injected into the system layer at run time (after instructions, before history). */
  readonly context?: readonly ContextProvider[];
  /** Optional run-loop tool authorizer applied after schema validation. */
  readonly authorizer?: ToolAuthorizer;
  /** Optional unified tool policy engine applied after authorization. */
  readonly policy?: PolicyEngine;
  /** Optional host principal id threaded to authorization/policy/tool context. */
  readonly principal?: string;
  /** Optional host role set threaded to authorization. */
  readonly roles?: readonly string[];
  /** Optional run-loop approval gate applied to every regular tool call. */
  readonly approval?: ApprovalPolicy;
  /** Optional channel used by `ask_human` tools to wait for host-provided input. */
  readonly humanInput?: HumanInputGateway;
  /** Optional provider-token budget enforced before and after provider turns. */
  readonly budget?: RunBudget;
  /** Optional limiter acquired before each provider call. */
  readonly rateLimiter?: RateLimiter;
  /** Optional retry policy wrapping provider calls. */
  readonly retry?: RetryPolicy;
  /** Optional content filters for provider input and tool output. */
  readonly filters?: ContentFilterConfig;
  /** Token budgeting for the messages sent to the provider (does not affect persisted/returned history). */
  readonly contextWindow?: ContextWindowOptions;
  /** Per-run generation overrides, merged over the agent's `generation` defaults. */
  readonly generation?: GenerationSettings;
  /** Cap on provider turns (model→tools→model cycles). Defaults to 16. */
  readonly maxSteps?: number;
  /** Stream tokens + tool lifecycle. Omitted/`false` → buffered `Promise<RunResult>`. */
  readonly stream?: boolean;
  /** Event sink invoked for every {@link RunEvent}, in both buffered and streaming modes. */
  readonly onEvent?: (event: RunEvent) => void;
  /**
   * Additional independent event subscribers (UI streaming, audit log, metrics,
   * a `forge/messaging` bridge). Dispatched after {@link RunOptions.onEvent}, in
   * order, awaited per event. A subscriber that throws/rejects is isolated — it
   * neither aborts the run nor starves the others.
   */
  readonly subscribers?: readonly RunSubscriber[];
  /** Forge telemetry handle, threaded to provider calls / tools / hooks. */
  readonly telemetry?: TelemetryHandle;
  /** Structured logger (defaults to `telemetry.log`). */
  readonly logger?: Logger;
  /** Cancellation signal; halts the loop and in-flight provider/tool calls. */
  readonly signal?: AbortSignal;
  /**
   * Cap on agent handoffs in a single run, to bound triage↔specialist
   * ping-pong (Phase 7). Defaults to 8. Exceeding it
   * throws {@link MaxHandoffsExceededError}.
   */
  readonly maxHandoffs?: number;
  /**
   * Registry used to resolve string-named {@link AgentDefinition.handoffs}
   * targets (Phase 7). Not needed when every handoff target is given directly
   * as an {@link AgentDefinition}.
   */
  readonly registry?: AgentRegistry;
}

/** Options for buffered mode. This is the default when `stream` is omitted. */
export type BufferedRunOptions = Omit<RunOptions, "stream"> & {
  readonly stream?: false | undefined;
};

/** Options for streaming mode. */
export type StreamingRunOptions = Omit<RunOptions, "stream"> & {
  readonly stream: true;
};

/**
 * Options for callers that decide streaming dynamically. Passing this shape to
 * `runAgent` returns `Promise<RunResult> | RunHandle`.
 */
export type AnyRunOptions = Omit<RunOptions, "stream"> & {
  readonly stream?: boolean;
};

/** The buffered result of a completed run. */
export interface RunResult {
  /** Per-invocation correlation id shared by events and checkpoints for this run. */
  readonly runId: string;
  /** Concatenated text of the final assistant message. */
  readonly output: string;
  /** The final assistant message. */
  readonly finalMessage: Message;
  /** Full history: prior messages + input + every assistant turn + tool results. */
  readonly messages: Message[];
  /** Why the loop ended. */
  readonly finishReason: FinishReason;
  /** Number of provider turns taken. */
  readonly steps: number;
  /** Token usage aggregated across all turns (zeros when unreported). */
  readonly usage: Usage;
  /**
   * Name of the agent that produced the final answer (Phase 7). Equals the
   * agent passed to {@link runAgent} unless the run handed off to another.
   */
  readonly agent: string;
  /**
   * Ordered trail of agent names the run handed off to (Phase 7). Empty when no
   * handoff occurred; the final entry equals {@link RunResult.agent}.
   */
  readonly handoffs: readonly string[];
}

/**
 * A streaming run: an async-iterable of {@link RunEvent}s, plus `completed`
 * which resolves with the final {@link RunResult} once the stream is fully
 * consumed (the same result is also delivered as the `run.finish` event).
 *
 * If iteration throws, `completed` rejects with the same error. If the consumer
 * abandons iteration before a terminal event, `completed` rejects with
 * `CancelledError`.
 */
export type RunHandle = AsyncIterable<RunEvent> & {
  readonly completed: Promise<RunResult>;
};
