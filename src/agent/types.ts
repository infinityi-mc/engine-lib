/**
 * The agent contract — a declarative description of *what* an agent is.
 *
 * An {@link AgentDefinition} is plain data, not a class hierarchy: which
 * {@link Provider} to call, what {@link Instructions} to send, which
 * {@link ToolDefinition tools} the model may invoke, the default
 * {@link GenerationSettings generation settings}, and {@link AgentHooks}
 * lifecycle slots. The stable application path is `defineAgent`; hand-written
 * {@link AgentDefinition} objects are mainly useful for tests and adapters.
 * Definitions are data only: the run loop resolves instructions, invokes
 * hooks, advertises tools, and performs handoffs.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type {
  CompletionResult,
  Provider,
  ToolCall,
  ToolChoice,
  Usage,
} from "../providers/types";
import type { EngineContext } from "../runtime/types";
import type { AgentError } from "../errors";
import type { ToolDefinition, ToolResult } from "../tools/types";

/**
 * Default per-turn generation knobs an agent applies to each provider call.
 * A subset of the Phase-2 `CompletionRequest`; the run loop merges these in,
 * letting per-run overrides win.
 */
export interface GenerationSettings {
  /** Model id; falls back to the provider's `defaultModel` when omitted. */
  readonly model?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  /** How the model may use tools this turn. */
  readonly toolChoice?: ToolChoice;
}

/** Context available to dynamic {@link Instructions}. */
export interface InstructionContext extends EngineContext {
  readonly agent: AgentDefinition;
}

/**
 * System instructions: a static string, or a function of run context resolved
 * at run time so the host can fold in per-run facts. Resolved instructions are
 * injected into the system layer for the provider request, but are not persisted
 * to sessions.
 */
export type Instructions =
  | string
  | ((ctx: InstructionContext) => string | Promise<string>);

/**
 * Lifecycle hook slots. Declared here on the agent; the run loop invokes them
 * at well-defined points. All hooks are optional, awaited, and receive the
 * shared engine context.
 *
 * Public `RunEvent`s are emitted before the corresponding hook is invoked.
 * Hook failures fail the run and are routed through `onError`; an `onError`
 * failure never replaces the original run failure.
 */
export interface AgentHooks {
  /** Before the first provider call. */
  onStart?(
    event: { agent: AgentDefinition; messages: Message[] },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** After each completed provider turn. */
  onStep?(
    event: { step: number; result: CompletionResult },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** Before a validated tool call is dispatched. */
  onToolCall?(
    event: { call: ToolCall; tool: ToolDefinition },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** After a tool produces a result. */
  onToolResult?(
    event: { call: ToolCall; result: ToolResult },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** When the run produces its final answer. */
  onFinish?(
    event: { output: string; usage?: Usage },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** When the run fails. */
  onError?(
    event: { error: AgentError },
    ctx: EngineContext,
  ): void | Promise<void>;
  /** When this agent hands the run off to another agent (Phase 7). */
  onHandoff?(
    event: { from: AgentDefinition; to: AgentDefinition },
    ctx: EngineContext,
  ): void | Promise<void>;
}

/** A declarative agent definition — data describing behavior, executed by the runtime. */
export interface AgentDefinition {
  readonly name: string;
  /** Host-managed version used for session resume compatibility checks. */
  readonly version?: string;
  readonly provider: Provider;
  readonly instructions?: Instructions;
  readonly tools?: readonly ToolDefinition[];
  /**
   * Agents this one may hand the run off to (Phase 7). Each target becomes a
   * synthetic `transfer_to_<name>` tool the model can call to switch the active
   * agent. A target may be given directly as an {@link AgentDefinition}, or by
   * name as a `string` resolved through the {@link AgentRegistry} passed in
   * `RunOptions.registry`. String targets without a registry fail the run.
   */
  readonly handoffs?: readonly (AgentDefinition | string)[];
  /** Default generation settings applied to each turn. */
  readonly generation?: GenerationSettings;
  /** Lifecycle hook slots. */
  readonly hooks?: AgentHooks;
}
