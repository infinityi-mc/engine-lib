/**
 * Mapping between the Phase-1 message model and the OpenAI **Responses** API.
 *
 * @module
 */

import type { ContentPart, Message } from "../../messages/types";
import { isText, isToolCall, isToolResult, stringifyArguments, systemText, withoutSystem } from "../shared";
import type { CompletionRequest, CompletionResult, FinishReason, ToolCall, ToolChoice } from "../types";

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: OpenAIOutputItem[];
  usage?: OpenAIUsage;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
}

interface OpenAIOutputItem {
  type: string;
  // message
  content?: Array<{ type: string; text?: string; refusal?: string }>;
  // function_call
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

/** Map a Phase-1 content part to a Responses `input_*` content block. */
function toInputContent(part: ContentPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") {
    return { type: "input_image", image_url: part.data, detail: "auto" };
  }
  return undefined;
}

/** Map Phase-1 messages to the Responses `input` item array. */
function toInputItems(messages: readonly Message[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (isToolResult(part)) {
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: part.content.map((p) => p.text).join(""),
          });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const textParts = message.content.filter(isText).map((p) => p.text).join("");
      if (textParts !== "") items.push({ role: "assistant", content: textParts });
      for (const part of message.content) {
        if (isToolCall(part)) {
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: stringifyArguments(part.arguments),
          });
        }
      }
      continue;
    }

    // user (and any other inbound role)
    const content = message.content
      .map(toInputContent)
      .filter((c): c is Record<string, unknown> => c !== undefined);
    items.push({ role: "user", content });
  }
  return items;
}

function toToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

/** Build a Responses `POST /responses` request body. */
export function buildOpenAIBody(req: CompletionRequest, model: string, stream: boolean): unknown {
  const system = systemText(req.messages);
  const body: Record<string, unknown> = {
    model,
    input: toInputItems(withoutSystem(req.messages)),
    stream,
  };
  if (system !== undefined) body["instructions"] = system;
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.parameters,
      strict: true,
    }));
  }
  if (req.toolChoice !== undefined) body["tool_choice"] = toToolChoice(req.toolChoice);
  if (req.responseSchema !== undefined) {
    body["text"] = {
      format: {
        type: "json_schema",
        name: req.responseSchema.name,
        schema: req.responseSchema.schema,
        strict: req.responseSchema.strict ?? true,
      },
    };
  }
  if (req.maxOutputTokens !== undefined) body["max_output_tokens"] = req.maxOutputTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.metadata !== undefined) body["metadata"] = req.metadata;
  if (req.providerOptions !== undefined) Object.assign(body, req.providerOptions);
  return body;
}

/** Map a Responses `status` (+ details) to a normalized {@link FinishReason}. */
function toFinishReason(response: OpenAIResponse, hadToolCalls: boolean, hadRefusal: boolean): FinishReason {
  if (response.status === "failed") return "error";
  if (hadRefusal) return "content_filter";
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  }
  if (hadToolCalls) return "tool_calls";
  return "stop";
}

/** Parse a Responses response object into a {@link CompletionResult}. */
export function parseOpenAIResponse(raw: unknown, model: string): CompletionResult {
  const response = (raw ?? {}) as OpenAIResponse;
  let text = "";
  let hadRefusal = false;
  const toolCalls: ToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text !== undefined) text += part.text;
        else if (part.type === "refusal") hadRefusal = true;
      }
    } else if (item.type === "function_call") {
      const argumentsText = item.arguments ?? "";
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        arguments: parseArguments(argumentsText),
        argumentsText,
      });
    }
  }

  const content: ContentPart[] = [];
  if (text !== "") content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
  }

  const usage = response.usage
    ? {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        totalTokens: response.usage.total_tokens
          ?? (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
        ...(response.usage.output_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens }
          : {}),
        ...(response.usage.input_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
          : {}),
      }
    : undefined;

  return {
    message: { role: "assistant", content },
    toolCalls,
    finishReason: toFinishReason(response, toolCalls.length > 0, hadRefusal),
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
