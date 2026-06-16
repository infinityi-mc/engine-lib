/**
 * Context injection + context-window management contracts.
 *
 * A {@link ContextProvider} supplies run-time facts (system state, retrieved
 * documents, environment) that engine-lib merges into the system layer of a run —
 * the library *injects*; the host decides the content (no RAG engine). A
 * {@link ContextStrategy} keeps the growing history within the model's window via
 * pluggable token-budgeting (truncate / summarize), raising
 * `ContextWindowError` only when the history is irreducible. Window strategies
 * reduce the request view sent to the provider; they must not mutate persisted
 * or returned session history.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type { Provider } from "../providers/types";
import type { EngineContext } from "../runtime/types";

/** A unit of injected context, rendered into a system message at run time. */
export interface ContextItem {
  /** Optional heading shown before the rendered content. */
  readonly title?: string;
  /** Strings pass through; anything else is JSON-encoded when rendered. */
  readonly content: unknown;
}

/** Run-specific facts made available while resolving context providers. */
export interface ContextResolveContext {
  /** Active agent name for this run. */
  readonly agentName: string;
  /** Resolved agent instructions, when any. */
  readonly instructions?: string;
  /** New input messages for this run. */
  readonly input: readonly Message[];
  /** Prior conversation history loaded before this run's input. */
  readonly prior: readonly Message[];
  /** Prior history followed by this run's input, excluding instructions/context. */
  readonly messages: readonly Message[];
  /** Per-run context-window configuration, when supplied. */
  readonly contextWindow?: ContextWindowOptions;
}

/**
 * A host-supplied context source, resolved once per run before the first
 * provider call. Results are injected as system context and are not persisted.
 */
export interface ContextProvider {
  readonly name: string;
  resolve(
    ctx: EngineContext,
    run?: ContextResolveContext,
  ): ContextItem[] | Promise<ContextItem[]>;
}

/** Counts tokens for a message list (pluggable; a char-based heuristic ships built-in). */
export type TokenCounter = (messages: readonly Message[]) => number;

/** Inputs a {@link ContextStrategy} needs to reduce history (besides the messages). */
export interface ContextStrategyContext {
  readonly maxTokens: number;
  readonly countTokens: TokenCounter;
  /** Provider available to strategies that need a model call (e.g. summarize). */
  readonly provider: Provider;
  readonly model: string;
  readonly engine: EngineContext;
}

/** A pluggable history-reduction policy for the provider request view. */
export interface ContextStrategy {
  readonly name: string;
  /**
   * Reduce `messages` so `countTokens(result) <= maxTokens`. Must preserve
   * conversational validity (for example, keep required system messages).
   * Return a new request view and throw `ContextWindowError` when the history
   * cannot be reduced to fit.
   */
  reduce(
    messages: Message[],
    ctx: ContextStrategyContext,
  ): Message[] | Promise<Message[]>;
}

/** Per-run context-window budgeting configuration. */
export interface ContextWindowOptions {
  /** Maximum tokens the assembled request may consume. */
  readonly maxTokens: number;
  /** Reduction policy; defaults to `truncateOldest()`. */
  readonly strategy?: ContextStrategy;
  /** Token counter; defaults to the built-in character-based estimate. */
  readonly countTokens?: TokenCounter;
}
