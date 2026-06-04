/**
 * Mapping between the Phase-1 message model and the OpenAI-compatible
 * **Chat Completions** API (vLLM, Together, Groq, OpenRouter, …).
 *
 * @module
 */

import type { Message } from "../../messages/types";
import { isText, isToolCall, isToolResult, stringifyArguments, toolResultText } from "../shared";
import type { CompletionRequest, CompletionResult, FinishReason, ToolCall, ToolChoice } from "../types";

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatUsage;
}

/** Map Phase-1 messages to Chat Completions messages. */
function toChatMessages(messages: readonly Message[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content.filter(isText).map((p) => p.text).join("\n") });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (isToolResult(part)) {
          out.push({ role: "tool", tool_call_id: part.toolCallId, content: toolResultText(part) });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.filter(isText).map((p) => p.text).join("");
      const toolCalls = message.content.filter(isToolCall).map((part) => ({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: stringifyArguments(part.arguments) },
      }));
      out.push({
        role: "assistant",
        content: text !== "" ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user — array content when images are present, else a plain string
    const hasImage = message.content.some((p) => p.type === "image");
    if (hasImage) {
      const content: Record<string, unknown>[] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "image") content.push({ type: "image_url", image_url: { url: part.data } });
      }
      out.push({ role: "user", content });
    } else {
      out.push({ role: "user", content: message.content.filter(isText).map((p) => p.text).join("") });
    }
  }
  return out;
}

function toToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

/** Build a Chat Completions request body. */
export function buildChatBody(req: CompletionRequest, model: string, stream: boolean): unknown {
  const body: Record<string, unknown> = {
    model,
    messages: toChatMessages(req.messages),
    stream,
  };
  if (stream) body["stream_options"] = { include_usage: true };
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.parameters,
      },
    }));
  }
  if (req.toolChoice !== undefined) body["tool_choice"] = toToolChoice(req.toolChoice);
  if (req.responseSchema !== undefined) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: req.responseSchema.name,
        schema: req.responseSchema.schema,
        strict: req.responseSchema.strict ?? true,
      },
    };
  }
  if (req.maxOutputTokens !== undefined) body["max_tokens"] = req.maxOutputTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stopSequences !== undefined) body["stop"] = req.stopSequences;
  if (req.metadata !== undefined) body["metadata"] = req.metadata;
  if (req.providerOptions !== undefined) Object.assign(body, req.providerOptions);
  return body;
}

/** Map a Chat Completions `finish_reason` to a normalized {@link FinishReason}. */
export function mapChatFinish(reason: string | undefined, hadToolCalls: boolean): FinishReason {
  switch (reason) {
    case "stop":
      return hadToolCalls ? "tool_calls" : "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return hadToolCalls ? "tool_calls" : "stop";
  }
}

/** Parse a Chat Completions response into a {@link CompletionResult}. */
export function parseChatResponse(raw: unknown, model: string): CompletionResult {
  const response = (raw ?? {}) as ChatResponse;
  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? "";
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => {
    const argumentsText = call.function?.arguments ?? "";
    return {
      id: call.id ?? "",
      name: call.function?.name ?? "",
      arguments: parseArguments(argumentsText),
      argumentsText,
    };
  });

  const content = [];
  if (text !== "") content.push({ type: "text" as const, text });
  for (const call of toolCalls) {
    content.push({ type: "tool_call" as const, id: call.id, name: call.name, arguments: call.arguments });
  }

  const usage = response.usage
    ? {
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
        totalTokens: response.usage.total_tokens
          ?? (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
        ...(response.usage.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: response.usage.completion_tokens_details.reasoning_tokens }
          : {}),
        ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens }
          : {}),
      }
    : undefined;

  return {
    message: { role: "assistant", content },
    toolCalls,
    finishReason: mapChatFinish(choice?.finish_reason, toolCalls.length > 0),
    ...(usage !== undefined ? { usage } : {}),
    model: response.model ?? model,
    raw,
  };
}

function parseArguments(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
