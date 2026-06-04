/**
 * Usage aggregation across the turns of a run.
 *
 * Provider {@link Usage} is reported per turn (and may be absent); the run loop
 * folds each turn's usage into a running total so {@link RunResult.usage}
 * reflects the whole run.
 *
 * @module
 */

import type { Usage } from "../providers/types";

/** A zeroed {@link Usage} accumulator. */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** Field-wise sum of two {@link Usage} values; optional fields appear only when present. */
export function addUsage(a: Usage, b?: Usage): Usage {
  if (b === undefined) return a;
  const reasoningTokens =
    a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
      : undefined;
  const cachedInputTokens =
    a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)
      : undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}
