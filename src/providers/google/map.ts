/**
 * Mapping between the Phase-1 message model and the Google Gemini
 * **generateContent** API.
 *
 * @module
 */

import type { ImagePart, Message } from "../../messages/types";
import { isText, isToolCall, isToolResult, systemText, toolResultText, withoutSystem } from "../shared";
import type { CompletionRequest, CompletionResult, FinishReason, ToolCall, ToolChoice } from "../types";

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsage;
}

/** Map a Phase-1 image part to a Gemini part. */
function toGeminiImage(part: ImagePart): Record<string, unknown> {
  const isUrl = /^https?:\/\//.test(part.data);
  return isUrl
    ? { fileData: { mimeType: part.mimeType, fileUri: part.data } }
    : { inlineData: { mimeType: part.mimeType, data: part.data } };
}

/** Build an id→name map of tool calls so tool results can echo the name. */
function toolNameById(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (isToolCall(part)) names.set(part.id, part.name);
    }
  }
  return names;
}

/** Map Phase-1 messages to Gemini `contents`. */
function toContents(messages: readonly Message[]): unknown[] {
  const toolNames = toolNameById(messages);
  const contents: unknown[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const parts = message.content.filter(isToolResult).map((part) => ({
        functionResponse: {
          id: part.toolCallId,
          name: toolNames.get(part.toolCallId) ?? part.toolCallId,
          response: { result: toolResultText(part) },
        },
      }));
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant") {
      const parts: unknown[] = [];
      for (const part of message.content) {
        if (isText(part)) parts.push({ text: part.text });
        else if (isToolCall(part)) {
          parts.push({ functionCall: { id: part.id, name: part.name, args: part.arguments ?? {} } });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    // user
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (isText(part)) parts.push({ text: part.text });
      else if (part.type === "image") parts.push(toGeminiImage(part));
    }
    contents.push({ role: "user", parts });
  }
  return contents;
}

function toToolConfig(choice: ToolChoice): unknown {
  if (typeof choice === "object") {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
  }
  const mode = choice === "none" ? "NONE" : choice === "required" ? "ANY" : "AUTO";
  return { functionCallingConfig: { mode } };
}

/** Build a Gemini generateContent request body. */
export function buildGoogleBody(req: CompletionRequest, _model: string, _stream: boolean): unknown {
  const system = systemText(req.messages);
  const body: Record<string, unknown> = {
    contents: toContents(withoutSystem(req.messages)),
  };
  if (system !== undefined) body["systemInstruction"] = { parts: [{ text: system }] };
  if (req.tools && req.tools.length > 0) {
    body["tools"] = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.parameters,
        })),
      },
    ];
  }
  if (req.toolChoice !== undefined) body["toolConfig"] = toToolConfig(req.toolChoice);

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig["temperature"] = req.temperature;
  if (req.topP !== undefined) generationConfig["topP"] = req.topP;
  if (req.maxOutputTokens !== undefined) generationConfig["maxOutputTokens"] = req.maxOutputTokens;
  if (req.stopSequences !== undefined) generationConfig["stopSequences"] = req.stopSequences;
  if (req.responseSchema !== undefined) {
    generationConfig["responseMimeType"] = "application/json";
    generationConfig["responseSchema"] = req.responseSchema.schema;
  }
  if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
  if (req.providerOptions !== undefined) Object.assign(body, req.providerOptions);
  return body;
}

/** Map a Gemini `finishReason` to a normalized {@link FinishReason}. */
export function mapGoogleFinish(reason: string | undefined, hadToolCalls: boolean): FinishReason {
  if (hadToolCalls && (reason === undefined || reason === "STOP")) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
    case "IMAGE_SAFETY":
    case "IMAGE_PROHIBITED_CONTENT":
      return "content_filter";
    case undefined:
      return "stop";
    default:
      return "other";
  }
}

/** Parse a Gemini generateContent response into a {@link CompletionResult}. */
export function parseGoogleResponse(raw: unknown, model: string): CompletionResult {
  const response = (raw ?? {}) as GeminiResponse;
  const candidate = response.candidates?.[0];
  let text = "";
  const toolCalls: ToolCall[] = [];
  let index = 0;

  for (const part of candidate?.content?.parts ?? []) {
    if (part.text !== undefined) text += part.text;
    else if (part.functionCall !== undefined) {
      const name = part.functionCall.name ?? "";
      toolCalls.push({
        id: part.functionCall.id ?? `call_${name}_${index}`,
        name,
        arguments: part.functionCall.args,
        argumentsText: JSON.stringify(part.functionCall.args ?? {}),
      });
      index += 1;
    }
  }

  const content = [];
  if (text !== "") content.push({ type: "text" as const, text });
  for (const call of toolCalls) {
    content.push({ type: "tool_call" as const, id: call.id, name: call.name, arguments: call.arguments });
  }

  const meta = response.usageMetadata;
  const usage = meta
    ? {
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: meta.candidatesTokenCount ?? 0,
        totalTokens: meta.totalTokenCount
          ?? (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        ...(meta.thoughtsTokenCount !== undefined ? { reasoningTokens: meta.thoughtsTokenCount } : {}),
        ...(meta.cachedContentTokenCount !== undefined ? { cachedInputTokens: meta.cachedContentTokenCount } : {}),
      }
    : undefined;

  return {
    message: { role: "assistant", content },
    toolCalls,
    finishReason: mapGoogleFinish(candidate?.finishReason, toolCalls.length > 0),
    ...(usage !== undefined ? { usage } : {}),
    model: response.modelVersion ?? model,
    raw,
  };
}
