/**
 * Context-window management: a default token estimator, two built-in reduction
 * strategies ({@link truncateOldest}, {@link summarizeOldest}), and
 * {@link applyContextWindow} which produces the (possibly trimmed) message view
 * sent to the provider without mutating the canonical history.
 *
 * {@link truncateOldest} is the stable default. {@link summarizeOldest} is also
 * public, but it performs an additional provider call and should be chosen
 * deliberately when summarization is acceptable.
 *
 * @module
 */

import { ContextWindowError } from "../errors";
import { system } from "../messages/factory";
import type { ContentPart, Message } from "../messages/types";
import type {
  ContextStrategy,
  ContextStrategyContext,
  ContextWindowOptions,
  TokenCounter,
} from "./types";

/** Approximate token count of one content part. */
function partChars(part: ContentPart): number {
  switch (part.type) {
    case "text":
      return part.text.length;
    case "tool_result":
      return part.content.reduce((n, t) => n + t.text.length, 0);
    case "tool_call":
      return part.name.length + JSON.stringify(part.arguments ?? null).length;
    case "image":
      return part.data.length;
  }
}

/**
 * Default {@link TokenCounter}: a provider-agnostic heuristic of ~4 chars/token
 * over all message text. Swap in a real tokenizer via `ContextWindowOptions.countTokens`.
 */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.content) chars += partChars(part);
  }
  return Math.ceil(chars / 4);
}

interface MessageGroup {
  readonly messages: readonly Message[];
  readonly pinned: boolean;
}

function messagePinned(
  message: Message,
  index: number,
  pin?: (message: Message, index: number) => boolean,
): boolean {
  return (
    message.role === "system" ||
    message.metadata?.pinned === true ||
    pin?.(message, index) === true
  );
}

function hasToolCall(message: Message): boolean {
  return message.content.some((part) => part.type === "tool_call");
}

function isToolResultMessage(message: Message): boolean {
  return (
    message.role === "tool" &&
    message.content.some((part) => part.type === "tool_result")
  );
}

/** Split messages into request-valid groups, keeping tool-call/result turns intact. */
export function splitConversationTurns(
  messages: readonly Message[],
  pin?: (message: Message, index: number) => boolean,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    const start = index;
    const group: Message[] = [message];
    index += 1;
    if (message.role === "assistant" && hasToolCall(message)) {
      while (index < messages.length && isToolResultMessage(messages[index]!)) {
        group.push(messages[index]!);
        index += 1;
      }
    }
    groups.push({
      messages: group,
      pinned: group.some((m, offset) => messagePinned(m, start + offset, pin)),
    });
  }
  return groups;
}

function flattenGroups(groups: readonly MessageGroup[]): Message[] {
  return groups.flatMap((group) => [...group.messages]);
}

function latestNonSystemGroupIndex(groups: readonly MessageGroup[]): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index]!.messages.some((message) => message.role !== "system"))
      return index;
  }
  return -1;
}

/** Render messages to a plain-text transcript (for summarization prompts). */
function transcript(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const body = m.content
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "tool_result")
            return p.content.map((t) => t.text).join(" ");
          if (p.type === "tool_call")
            return `[tool_call ${p.name} ${JSON.stringify(p.arguments)}]`;
          return "";
        })
        .filter((s) => s !== "")
        .join(" ");
      return `${m.role}: ${body}`;
    })
    .join("\n");
}

/**
 * Drop the oldest non-`system` messages until the history fits `maxTokens`.
 * System messages are always retained; if they alone exceed the budget the
 * history is irreducible and {@link ContextWindowError} is thrown. This is the
 * default stable context-window strategy.
 */
export function truncateOldest(): ContextStrategy {
  return {
    name: "truncate-oldest",
    reduce(messages, ctx) {
      const systemMsgs = messages.filter((m) => m.role === "system");
      const rest = messages.filter((m) => m.role !== "system");

      const kept = [...rest];
      while (
        kept.length > 0 &&
        ctx.countTokens([...systemMsgs, ...kept]) > ctx.maxTokens
      ) {
        kept.shift();
      }
      const result = [...systemMsgs, ...kept];
      const tokens = ctx.countTokens(result);
      if (tokens > ctx.maxTokens) {
        throw new ContextWindowError(
          `context window exceeded: ${tokens} tokens > limit ${ctx.maxTokens} (irreducible)`,
          { tokens, limit: ctx.maxTokens },
        );
      }
      return result;
    },
  };
}

/**
 * Drop oldest whole turns while preserving system messages, pinned messages,
 * and assistant tool-call/result pairing.
 */
export function truncateToolAware(
  opts: {
    pin?: (message: Message, index: number) => boolean;
  } = {},
): ContextStrategy {
  return {
    name: "truncate-tool-aware",
    reduce(messages, ctx) {
      const groups = splitConversationTurns(messages, opts.pin);
      const keep = new Set<number>();
      const latest = latestNonSystemGroupIndex(groups);
      groups.forEach((group, index) => {
        if (group.pinned || index === latest) keep.add(index);
      });

      for (let index = groups.length - 1; index >= 0; index -= 1) {
        if (keep.has(index)) continue;
        const candidate = flattenGroups(
          groups.filter((_, i) => keep.has(i) || i === index),
        );
        if (ctx.countTokens(candidate) <= ctx.maxTokens) {
          keep.add(index);
        }
      }

      const result = flattenGroups(
        groups.filter((_, index) => keep.has(index)),
      );
      const tokens = ctx.countTokens(result);
      if (tokens > ctx.maxTokens) {
        throw new ContextWindowError(
          `context window exceeded: ${tokens} tokens > limit ${ctx.maxTokens} (irreducible)`,
          { tokens, limit: ctx.maxTokens },
        );
      }
      return result;
    },
  };
}

/**
 * Compress the oldest overflow into a single `system` summary via a provider
 * call, keeping the most recent `keepRecent` (default 4) non-system messages
 * verbatim. Throws {@link ContextWindowError} if the result still overflows.
 */
export function summarizeOldest(
  opts: { keepRecent?: number } = {},
): ContextStrategy {
  const keepRecent = opts.keepRecent ?? 4;
  return {
    name: "summarize-oldest",
    async reduce(messages, ctx) {
      const systemMsgs = messages.filter((m) => m.role === "system");
      const rest = messages.filter((m) => m.role !== "system");
      const groups = splitConversationTurns(rest);
      const splitAt = Math.max(0, groups.length - keepRecent);
      const older = flattenGroups(groups.slice(0, splitAt));
      const recent = flattenGroups(groups.slice(splitAt));

      let result: Message[];
      if (older.length === 0) {
        result = [...systemMsgs, ...recent];
      } else {
        const req = {
          model: ctx.model,
          messages: [
            system(
              "Summarize the following conversation transcript concisely, preserving " +
                "facts, decisions, open questions, and any in-flight tool intent. Output only the summary.",
            ),
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: transcript(older) }],
            },
          ],
        };
        const completion = await ctx.provider.complete(req, ctx.engine);
        const summaryText = completion.message.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        const summary = system(
          `Summary of earlier conversation:\n${summaryText}`,
        );
        result = [...systemMsgs, summary, ...recent];
      }

      const tokens = ctx.countTokens(result);
      if (tokens > ctx.maxTokens) {
        throw new ContextWindowError(
          `context window exceeded: ${tokens} tokens > limit ${ctx.maxTokens} (irreducible)`,
          { tokens, limit: ctx.maxTokens },
        );
      }
      return result;
    },
  };
}

/**
 * Produce the message view to send to the provider. Returns `messages` unchanged
 * when no `window` is configured or the history already fits; otherwise applies
 * the configured (or default `truncateOldest`) strategy. Never mutates the input
 * or persisted session history.
 */
export async function applyContextWindow(
  messages: Message[],
  window: ContextWindowOptions | undefined,
  ctx: Pick<ContextStrategyContext, "provider" | "model" | "engine">,
): Promise<Message[]> {
  if (window === undefined) return messages;
  const countTokens: TokenCounter = window.countTokens ?? estimateTokens;
  if (countTokens(messages) <= window.maxTokens) return messages;
  const strategy = window.strategy ?? truncateOldest();
  return strategy.reduce([...messages], {
    maxTokens: window.maxTokens,
    countTokens,
    provider: ctx.provider,
    model: ctx.model,
    engine: ctx.engine,
  });
}
