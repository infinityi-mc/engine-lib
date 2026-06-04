/**
 * Mapping between the Phase-1 message model and the Anthropic **Messages** API.
 *
 * @module
 */

import type { ImagePart, Message } from "../../messages/types";
import { isText, isToolCall, isToolResult, systemText, toolResultText, withoutSystem } from "../shared";
import type { CompletionRequest, CompletionResult, FinishReason, ToolCall, ToolChoice } from "../types";

const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

/** Map a Phase-1 image part to an Anthropic image block source. */
function toImageBlock(part: ImagePart): Record<string, unknown> {
  const isUrl = /^https?:\/\//.test(part.data);
  return {
    type: "image",
    source: isUrl
      ? { type: "url", url: part.data }
      : { type: "base64", media_type: part.mimeType, data: part.data },
  };
}

/** Map Phase-1 messages to Anthropic `messages`, folding tool results into user turns. */
function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  const pushUserBlocks = (blocks: unknown[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };

  for (const message of messages) {
    if (message.role === "tool") {
      const blocks = message.content.filter(isToolResult).map((part) => ({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: toolResultText(part),
        ...(part.isError !== undefined ? { is_error: part.isError } : {}),
      }));
      pushUserBlocks(blocks);
      continue;
    }

    if (message.role === "assistant") {
      const blocks: unknown[] = [];
      for (const part of message.content) {
        if (isText(part)) blocks.push({ type: "text", text: part.text });
        else if (isToolCall(part)) {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments ?? {} });
        }
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // user
    const blocks: unknown[] = [];
    for (const part of message.content) {
      if (isText(part)) blocks.push({ type: "text", text: part.text });
      else if (part.type === "image") blocks.push(toImageBlock(part));
    }
    pushUserBlocks(blocks);
  }
  return out;
}

function toToolChoice(choice: ToolChoice): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

/** Build an Anthropic `POST /messages` request body. */
export function buildAnthropicBody(req: CompletionRequest, model: string, stream: boolean): unknown {
  const system = systemText(req.messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(withoutSystem(req.messages)),
    stream,
  };
  if (system !== undefined) body["system"] = system;
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      input_schema: t.parameters,
      strict: true,
    }));
  }
  if (req.toolChoice !== undefined) body["tool_choice"] = toToolChoice(req.toolChoice);
  if (req.responseSchema !== undefined) {
    body["output_config"] = {
      format: { type: "json_schema", schema: req.responseSchema.schema },
    };
  }
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stopSequences !== undefined) body["stop_sequences"] = req.stopSequences;
  if (req.metadata?.["userId"] !== undefined) body["metadata"] = { user_id: req.metadata["userId"] };
  if (req.providerOptions !== undefined) Object.assign(body, req.providerOptions);
  return body;
}

/** Map an Anthropic `stop_reason` to a normalized {@link FinishReason}. */
export function mapStopReason(stopReason: string | null | undefined, hadToolCalls: boolean): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return hadToolCalls ? "tool_calls" : "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return hadToolCalls ? "tool_calls" : "other";
  }
}

/** Parse an Anthropic message response into a {@link CompletionResult}. */
export function parseAnthropicResponse(raw: unknown, model: string): CompletionResult {
  const response = (raw ?? {}) as AnthropicResponse;
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of response.content ?? []) {
    if (block.type === "text" && block.text !== undefined) text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: block.input,
        argumentsText: JSON.stringify(block.input ?? {}),
      });
    }
  }

  const content = [];
  if (text !== "") content.push({ type: "text" as const, text });
  for (const call of toolCalls) {
    content.push({ type: "tool_call" as const, id: call.id, name: call.name, arguments: call.arguments });
  }

  const usage = response.usage
    ? {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
        ...(response.usage.cache_read_input_tokens !== undefined
          ? { cachedInputTokens: response.usage.cache_read_input_tokens }
          : {}),
      }
    : undefined;

  return {
    message: { role: "assistant", content },
    toolCalls,
    finishReason: mapStopReason(response.stop_reason, toolCalls.length > 0),
    ...(usage !== undefined ? { usage } : {}),
    model: response.model ?? model,
    raw,
  };
}
