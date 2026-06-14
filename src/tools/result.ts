/**
 * Normalization between the Phase-3 tool layer and its neighbours.
 *
 * Two directions:
 * - {@link renderToolContent} / {@link toToolResultMessage} map a
 *   {@link ToolResult} *down* into the Phase-1 conversation model (a
 *   `role: "tool"` {@link Message}), reusing the `toolResult` factory.
 * - {@link toProviderTool} maps a {@link ToolDefinition} *across* into the
 *   Phase-2 {@link ProviderTool} the provider advertises to the model.
 *
 * @module
 */

import { text, toolResult } from "../messages/factory";
import type { Message, TextPart } from "../messages/types";
import type { ProviderTool } from "../providers/types";
import { applyFilters } from "../governance/filters";
import type { ContentFilterConfig, FilterContext } from "../governance/filters";
import type { ToolDefinition, ToolResult } from "./types";

/**
 * Render a {@link ToolResult}'s payload into `TextPart[]`.
 *
 * This rendering is part of the stable tool contract: strings pass through
 * unchanged; `undefined`/`null` become empty text; any other value is
 * JSON-encoded so structured results survive into the text-only Phase-1
 * tool-result part.
 */
export function renderToolContent(result: ToolResult): TextPart[] {
  const value = result.ok ? result.content : result.error;
  if (typeof value === "string") return [text(value)];
  if (value === undefined || value === null) return [text("")];
  return [text(JSON.stringify(value))];
}

/**
 * Map a {@link ToolResult} into a Phase-1 tool-result {@link Message}.
 *
 * A failure is marked `isError: true` so the model sees a recoverable tool
 * error rather than a crashed run.
 */
export function toToolResultMessage(
  toolCallId: string,
  result: ToolResult,
): Message {
  const content = renderToolContent(result);
  return result.ok
    ? toolResult(toolCallId, content)
    : toolResult(toolCallId, content, { isError: true });
}

/**
 * Map a tool result into a message after applying optional tool-output filters.
 * Non-text result structure is rendered first, then only the rendered text is redacted.
 */
export async function toFilteredToolResultMessage(
  toolCallId: string,
  result: ToolResult,
  filters: ContentFilterConfig | undefined,
  ctx: Omit<FilterContext, "stage" | "toolCallId"> = {},
): Promise<Message> {
  if (filters?.toolOutput === undefined || filters.toolOutput.length === 0) {
    return toToolResultMessage(toolCallId, result);
  }
  const content: TextPart[] = [];
  for (const part of renderToolContent(result)) {
    content.push(
      text(
        await applyFilters(
          part.text,
          filters.toolOutput,
          { ...ctx, stage: "tool-output", toolCallId },
          filters.onError,
        ),
      ),
    );
  }
  return result.ok
    ? toolResult(toolCallId, content)
    : toolResult(toolCallId, content, { isError: true });
}

/**
 * Project a {@link ToolDefinition} into the provider-facing {@link ProviderTool}
 * (name + optional description + JSON-Schema parameters).
 */
export function toProviderTool(tool: ToolDefinition): ProviderTool {
  return {
    name: tool.name,
    ...(tool.description !== undefined
      ? { description: tool.description }
      : {}),
    parameters: tool.parameters.jsonSchema,
  };
}
