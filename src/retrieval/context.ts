import { estimateTokens } from "../context/window";
import type {
  ContextItem,
  ContextProvider,
  ContextResolveContext,
  TokenCounter,
} from "../context/types";
import type { Message, TextPart } from "../messages/types";
import type { EngineContext } from "../runtime/types";
import type {
  RetrievalResult,
  RetrieverContextOptions,
  SourceAttribution,
  SourceLocation,
} from "./types";

/** N23: conservative default budget (tokens) when no window or explicit cap is set. */
const DEFAULT_RETRIEVAL_BUDGET = 4_096;

function textOf(message: Message): string {
  return message.content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function latestUserText(
  messages: readonly Message[] | undefined,
): string | undefined {
  if (messages === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textOf(message).trim();
    if (text !== "") return text;
  }
  return undefined;
}

async function resolveQuery(
  options: RetrieverContextOptions,
  ctx: EngineContext,
  run?: ContextResolveContext,
): Promise<string | undefined> {
  if (typeof options.query === "string")
    return options.query.trim() === "" ? undefined : options.query;
  if (typeof options.query === "function") {
    const query = await options.query(ctx, run);
    return query === undefined || query.trim() === "" ? undefined : query;
  }
  return latestUserText(run?.input) ?? latestUserText(run?.messages);
}

function messageForCount(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}

function countText(text: string, countTokens: TokenCounter): number {
  return countTokens([messageForCount(text)]);
}

function locationLabel(
  location: SourceLocation | undefined,
): string | undefined {
  if (location === undefined) return undefined;
  if (location.startLine !== undefined && location.endLine !== undefined) {
    return location.startLine === location.endLine
      ? `line ${location.startLine}`
      : `lines ${location.startLine}-${location.endLine}`;
  }
  if (location.startOffset !== undefined && location.endOffset !== undefined) {
    return `offsets ${location.startOffset}-${location.endOffset}`;
  }
  return undefined;
}

function sourceLabel(source: SourceAttribution | undefined): string {
  const name = source?.title ?? source?.uri ?? source?.id ?? "unknown source";
  const location = locationLabel(source?.location);
  return location === undefined ? name : `${name}, ${location}`;
}

function renderResult(
  result: RetrievalResult,
  citation: number,
  includeScores: boolean,
  text = result.text,
): string {
  const score = includeScores ? ` score=${result.score.toFixed(3)}` : "";
  return `[${citation}] ${sourceLabel(result.source)}${score}\n${text}`;
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}

function appendBlock(content: string, block: string): string {
  return content === "" ? block : `${content}\n\n${block}`;
}

function availableBudget(
  options: RetrieverContextOptions,
  run: ContextResolveContext | undefined,
  countTokens: TokenCounter,
): number | undefined {
  if (options.maxContextTokens !== undefined)
    return Math.max(0, options.maxContextTokens);
  if (run?.contextWindow === undefined) return DEFAULT_RETRIEVAL_BUDGET;
  const reserveTokens =
    options.reserveTokens ??
    Math.min(512, Math.floor(run.contextWindow.maxTokens * 0.1));
  const used = countTokens(run.messages);
  return Math.max(0, run.contextWindow.maxTokens - used - reserveTokens);
}

function truncateToFit(
  prefixContent: string,
  result: RetrievalResult,
  citation: number,
  budget: number,
  countTokens: TokenCounter,
  includeScores: boolean,
): string | undefined {
  let low = 1;
  let high = result.text.length;
  let best: string | undefined;
  // Keep exact budget checks against the full rendered candidate. Tokenizers are
  // not guaranteed to be additive across block boundaries, so counting only the
  // new block could admit context that exceeds the caller's budget.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = `${result.text.slice(0, mid).trimEnd()}\n[truncated]`;
    const block = renderResult(result, citation, includeScores, text);
    const candidate = appendBlock(prefixContent, block);
    if (countText(candidate, countTokens) <= budget) {
      best = block;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function selectResults(
  results: readonly RetrievalResult[],
  budget: number | undefined,
  countTokens: TokenCounter,
  includeScores: boolean,
): { readonly content: string; readonly selected: readonly RetrievalResult[] } {
  if (budget === undefined) {
    return {
      content: joinBlocks(
        results.map((result, index) =>
          renderResult(result, index + 1, includeScores),
        ),
      ),
      selected: results,
    };
  }
  if (budget <= 0) return { content: "", selected: [] };

  let content = "";
  const selected: RetrievalResult[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result === undefined) continue;
    const citation = selected.length + 1;
    const block = renderResult(result, citation, includeScores);
    const candidate = appendBlock(content, block);
    if (countText(candidate, countTokens) <= budget) {
      content = candidate;
      selected.push(result);
      continue;
    }

    const truncated = truncateToFit(
      content,
      result,
      citation,
      budget,
      countTokens,
      includeScores,
    );
    if (truncated !== undefined) {
      content = appendBlock(content, truncated);
      selected.push(result);
    }
    break;
  }
  return { content, selected };
}

/** Convert any retriever into a run-time context provider with citations. */
export function retrieverContext(
  options: RetrieverContextOptions,
): ContextProvider {
  return {
    name: options.name ?? `retriever:${options.retriever.name}`,
    async resolve(ctx, run): Promise<ContextItem[]> {
      const query = await resolveQuery(options, ctx, run);
      if (query === undefined) return [];
      const results = await options.retriever.retrieve(
        {
          query,
          ...(options.topK !== undefined ? { topK: options.topK } : {}),
          ...(options.minScore !== undefined
            ? { minScore: options.minScore }
            : {}),
        },
        ctx,
      );
      if (results.length === 0) return [];

      const countTokens =
        options.countTokens ??
        run?.contextWindow?.countTokens ??
        estimateTokens;
      const budget = availableBudget(options, run, countTokens);
      const rendered = selectResults(
        results,
        budget,
        countTokens,
        options.includeScores ?? false,
      );
      if (rendered.content === "") return [];
      await options.onResults?.(rendered.selected, query, ctx, run);
      return [
        {
          title: options.title ?? "Retrieved Context",
          content: rendered.content,
        },
      ];
    },
  };
}
