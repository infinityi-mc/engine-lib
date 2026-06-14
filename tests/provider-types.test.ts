import { describe, expect, it } from "bun:test";

import { user } from "../src/messages/index";
import {
  createAnthropic,
  createGoogle,
  createOpenAI,
  createOpenAICompatible,
  type AdapterSpec,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderCapabilities,
  type StreamEvent,
  type ToolChoice,
} from "../src/providers/index";
import type { JsonSchema } from "../src/schema/index";

function assertProviderTypes(): void {
  const openai: Provider = createOpenAI({ apiKey: "sk-test" });
  const anthropic: Provider = createAnthropic({ apiKey: "anthropic-test" });
  const google: Provider = createGoogle({ apiKey: "google-test" });
  const compatible: Provider = createOpenAICompatible({
    baseUrl: "http://localhost:1234/v1",
    model: "local-model",
    capabilities: { streaming: false, structuredOutput: false },
  });
  void [openai, anthropic, google, compatible];

  const parameters: JsonSchema = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  };

  const toolChoiceByName: ToolChoice = { name: "weather" };
  const request: CompletionRequest = {
    model: "override-model",
    messages: [user("weather?")],
    tools: [{ name: "weather", description: "Get weather.", parameters }],
    toolChoice: toolChoiceByName,
    responseSchema: {
      name: "weather_report",
      schema: parameters,
      strict: true,
    },
    maxOutputTokens: 500,
    temperature: 0.2,
    topP: 0.9,
    stopSequences: ["END"],
    metadata: { userId: "u1" },
    providerOptions: {
      reasoning: { effort: "medium" },
      safetySettings: [{ category: "x", threshold: "y" }],
    },
  };
  void request;

  const capabilities: ProviderCapabilities = {
    tools: true,
    streaming: true,
    multimodalInput: true,
    parallelToolCalls: true,
    structuredOutput: true,
  };

  // @ts-expect-error every capability flag is required.
  const incompleteCapabilities: ProviderCapabilities = {
    tools: true,
    streaming: true,
  };
  void [capabilities, incompleteCapabilities];

  const result: CompletionResult = {
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    model: "m",
    raw: { provider: "native" },
  };

  const raw: unknown = result.raw;
  // @ts-expect-error raw is intentionally unknown until the caller narrows it.
  const providerName: string = result.raw.provider;
  void [raw, providerName];

  const streamEvents: StreamEvent[] = [
    { type: "message_start", model: "m" },
    { type: "text_delta", text: "he" },
    { type: "text_delta", text: "llo" },
    { type: "tool_call_start", index: 0, id: "call_1", name: "weather" },
    { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"city"' },
    { type: "tool_call_delta", index: 0, argumentsTextDelta: ':"SF"}' },
    { type: "tool_call_end", index: 0 },
    {
      type: "finish",
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
  void streamEvents;

  const adapter: AdapterSpec = {
    name: "custom",
    defaultModel: "custom-model",
    capabilities,
    http: { baseUrl: "https://example.invalid", headers: {} },
    completePath: () => "complete",
    streamPath: () => "stream",
    buildBody: (req, model, stream) => ({ req, model, stream }),
    parseResponse: (_raw, model) => ({ ...result, model }),
    async *translateStream() {
      yield { type: "message_start", model: "custom-model" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  void adapter;
}

describe("provider type contract", () => {
  it("keeps factories, requests, results, streams, capabilities, and adapter specs stable", () => {
    void assertProviderTypes;
    expect(true).toBe(true);
  });
});
