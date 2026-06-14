import type { Usage } from "../providers/types";

export type BudgetField = "totalTokens" | "inputTokens" | "outputTokens";

export interface RunBudget {
  readonly maxTotalTokens?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly onBudgetExceeded?: "stop" | "warn";
  readonly scope?: "run" | "session";
}

export interface BudgetBreach {
  readonly field: BudgetField;
  readonly used: number;
  readonly limit: number;
}

export function evaluateBudget(
  budget: RunBudget,
  usage: Usage,
): readonly BudgetBreach[] {
  const breaches: BudgetBreach[] = [];
  if (
    budget.maxTotalTokens !== undefined &&
    usage.totalTokens > budget.maxTotalTokens
  ) {
    breaches.push({
      field: "totalTokens",
      used: usage.totalTokens,
      limit: budget.maxTotalTokens,
    });
  }
  if (
    budget.maxInputTokens !== undefined &&
    usage.inputTokens > budget.maxInputTokens
  ) {
    breaches.push({
      field: "inputTokens",
      used: usage.inputTokens,
      limit: budget.maxInputTokens,
    });
  }
  if (
    budget.maxOutputTokens !== undefined &&
    usage.outputTokens > budget.maxOutputTokens
  ) {
    breaches.push({
      field: "outputTokens",
      used: usage.outputTokens,
      limit: budget.maxOutputTokens,
    });
  }
  return breaches;
}
