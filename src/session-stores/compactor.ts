import { user } from "../messages/factory";
import type { Message, TextPart } from "../messages/types";
import type { Provider } from "../providers/types";
import { estimateTokens, splitConversationTurns } from "../context/window";
import type { TokenCounter } from "../context/types";
import type { SessionCompactor } from "./types";

export const SUMMARY_METADATA_KEY = "engine:summary" as const;

export interface SummarizingCompactorOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly keepRecentTurns?: number;
  readonly shouldCompactAt?: {
    readonly messages?: number;
    readonly tokens?: number;
  };
  readonly countTokens?: TokenCounter;
}

function textOf(message: Message): string {
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool_result")
        return part.content.map((text) => text.text).join(" ");
      if (part.type === "tool_call")
        return `[tool_call ${part.name} ${JSON.stringify(part.arguments)}]`;
      return "";
    })
    .filter((text) => text !== "")
    .join(" ");
}

function transcript(messages: readonly Message[]): string {
  return messages
    .map((message) => `${message.role}: ${textOf(message)}`)
    .join("\n");
}

function isSummaryMessage(message: Message): boolean {
  return message.metadata?.[SUMMARY_METADATA_KEY] === true;
}

function summaryText(messages: readonly Message[]): string {
  return messages
    .map(textOf)
    .filter((text) => text !== "")
    .join("\n\n");
}

function flatten(groups: ReturnType<typeof splitConversationTurns>): Message[] {
  return groups.flatMap((group) => [...group.messages]);
}

function makeSummaryMessage(summary: string): Message {
  const part: TextPart = {
    type: "text",
    text: `Summary of earlier conversation:\n${summary}`,
  };
  return {
    role: "system",
    content: [part],
    metadata: { pinned: true, [SUMMARY_METADATA_KEY]: true },
  };
}

/** Persistently compress old turns into one pinned system summary message. */
export function summarizingCompactor(
  opts: SummarizingCompactorOptions,
): SessionCompactor {
  const keepRecentTurns = opts.keepRecentTurns ?? 6;
  const threshold = opts.shouldCompactAt ?? { messages: 50 };
  const countTokens = opts.countTokens ?? estimateTokens;

  return {
    shouldCompact(state) {
      const nonSummaryMessages = state.messages.filter(
        (message) => !isSummaryMessage(message),
      );
      const rest = nonSummaryMessages.filter(
        (message) => message.role !== "system",
      );
      const groups = splitConversationTurns(rest);
      if (groups.length <= keepRecentTurns) return false;

      const messageThresholdHit =
        threshold.messages !== undefined &&
        state.messages.length > threshold.messages;
      const tokenThresholdHit =
        threshold.tokens !== undefined &&
        countTokens(state.messages) > threshold.tokens;
      return messageThresholdHit || tokenThresholdHit;
    },
    async compact(state) {
      const existingSummaries = state.messages.filter(isSummaryMessage);
      const withoutSummaries = state.messages.filter(
        (message) => !isSummaryMessage(message),
      );
      const systemMessages = withoutSummaries.filter(
        (message) => message.role === "system",
      );
      const rest = withoutSummaries.filter(
        (message) => message.role !== "system",
      );
      const groups = splitConversationTurns(rest);
      const splitAt = Math.max(0, groups.length - keepRecentTurns);
      const older = flatten(groups.slice(0, splitAt));
      const recent = flatten(groups.slice(splitAt));

      if (older.length === 0) return state;

      const priorSummary = summaryText(existingSummaries);
      const promptBody = [
        priorSummary === "" ? undefined : `Existing summary:\n${priorSummary}`,
        `Conversation to fold into the summary:\n${transcript(older)}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n");

      const completion = await opts.provider.complete({
        model: opts.model,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text:
                  "Summarize the conversation for durable session resume. Preserve facts, " +
                  "decisions, open questions, user preferences, and in-flight tool intent. " +
                  "Output only the updated summary.",
              },
            ],
          },
          user(promptBody),
        ],
      });

      const summary = completion.message.content
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");

      return {
        state: {
          id: state.id,
          messages: [...systemMessages, makeSummaryMessage(summary), ...recent],
          ...(state.metadata !== undefined ? { metadata: state.metadata } : {}),
          ...(state.version !== undefined ? { version: state.version } : {}),
          ...(state.tenantId !== undefined ? { tenantId: state.tenantId } : {}),
        },
        archive: {
          messages: [...existingSummaries, ...older],
          reason: "summarized",
        },
      };
    },
  };
}
