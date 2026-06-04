/**
 * The agent contract — a declarative description of *what* an agent is.
 *
 * An {@link AgentDefinition} is plain data, not a class hierarchy: which
 * {@link Provider} to call, what {@link Instructions} to send, which
 * {@link ToolDefinition tools} the model may invoke, the default
 * {@link GenerationSettings generation settings}, and {@link AgentHooks}
 * lifecycle slots. Phase 3 only *defines* these shapes; the Phase-4 run loop
 * consumes them and the Phase-6 event system invokes the hooks.
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

/** Context available to dynamic {@link Instructions} (extended with injected context in Phase 5). */
export interface InstructionContext extends EngineContext {
  readonly agent: AgentDefinition;
}

/**
 * System instructions: a static string, or a function of run context resolved
 * at run time (Phase 4) so the host can fold in per-run facts.
 */
export type Instructions =
  | string
  | ((ctx: InstructionContext) => string | Promise<string>);

/**
 * Lifecycle hook slots. Declared here on the agent; the Phase-4 loop / Phase-6
 * event system invoke them at well-defined points. All are optional and may be
 * async (awaited in declaration order).
 */
export interface AgentHooks {
  /** Before the first provider call. */
  onStart?(event: { agent: AgentDefinition; messages: Message[] }, ctx: EngineContext): void | Promise<void>;
  /** After each completed provider turn. */
  onStep?(event: { step: number; result: CompletionResult }, ctx: EngineContext): void | Promise<void>;
  /** Before a validated tool call is dispatched. */
  onToolCall?(event: { call: ToolCall; tool: ToolDefinition }, ctx: EngineContext): void | Promise<void>;
  /** After a tool produces a result. */
  onToolResult?(event: { call: ToolCall; result: ToolResult }, ctx: EngineContext): void | Promise<void>;
  /** When the run produces its final answer. */
  onFinish?(event: { output: string; usage?: Usage }, ctx: EngineContext): void | Promise<void>;
  /** When the run fails. */
  onError?(event: { error: AgentError }, ctx: EngineContext): void | Promise<void>;
}

/** A declarative agent definition — data describing behavior, executed by the runtime. */
export interface AgentDefinition {
  readonly name: string;
  readonly provider: Provider;
  readonly instructions?: Instructions;
  readonly tools?: readonly ToolDefinition[];
  /** Default generation settings applied to each turn. */
  readonly generation?: GenerationSettings;
  /** Lifecycle hook slots. */
  readonly hooks?: AgentHooks;
}
