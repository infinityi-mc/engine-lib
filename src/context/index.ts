/**
 * `engine-lib/context` — run-time context injection ({@link staticContext},
 * {@link dynamicContext}) and context-window management ({@link truncateOldest},
 * {@link summarizeOldest}, {@link estimateTokens}). engine-lib injects context and
 * keeps history within budget; the host owns the content and retrieval.
 *
 * @module
 */

export { dynamicContext, resolveContext, staticContext } from "./providers";

export {
  applyContextWindow,
  estimateTokens,
  summarizeOldest,
  truncateOldest,
} from "./window";

export type {
  ContextItem,
  ContextProvider,
  ContextStrategy,
  ContextStrategyContext,
  ContextWindowOptions,
  TokenCounter,
} from "./types";
