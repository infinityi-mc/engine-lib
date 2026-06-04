import { describe, expect, it } from "bun:test";

import { assistant, system, toolResult, user } from "../../src/messages/index";
import { buildGoogleBody, parseGoogleResponse } from "../../src/providers/google/map";
import { translateGoogleStream } from "../../src/providers/google/stream";
import type { CompletionRequest } from "../../src/providers/types";
import type { ToolCallPart } from "../../src/messages/types";
import { collect, sseMessages } from "./helpers";

describe("buildGoogleBody", () => {
  it("maps system → systemInstruction and roles user/assistant → user/model", () => {
    const req: CompletionRequest = { messages: [system("sys"), user("hi"), assistant("yo")] };
    const body = buildGoogleBody(req, "gemini", false) as Record<string, any>;
    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "sys" }] });
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "yo" }] },
    ]);
  });

  it("maps a tool result to functionResponse echoing the call name", () => {
    const toolCall: ToolCallPart = { type: "tool_call", id: "c1", name: "lookup", arguments: {} };
    const req: CompletionRequest = { messages: [assistant([toolCall]), toolResult("c1", "data")] };
    const body = buildGoogleBody(req, "gemini", false) as Record<string, any>;
    expect(body["contents"][1]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "c1", name: "lookup", response: { result: "data" } } }],
    });
  });

  it("nests function declarations under tools and toolConfig", () => {
    const req: CompletionRequest = {
      messages: [user("x")],
      tools: [{ name: "f", parameters: { type: "object" } }],
      toolChoice: "required",
    };
    const body = buildGoogleBody(req, "gemini", false) as Record<string, any>;
    expect(body["tools"]).toEqual([{ functionDeclarations: [{ name: "f", parameters: { type: "object" } }] }]);
    expect(body["toolConfig"]).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });
});

describe("parseGoogleResponse", () => {
  it("parses parts + finishReason + usageMetadata", () => {
    const raw = {
      modelVersion: "gemini",
      candidates: [
        {
          content: { parts: [{ text: "hi" }, { functionCall: { id: "c1", name: "f", args: { a: 1 } } }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10, cachedContentTokenCount: 4 },
    };
    const result = parseGoogleResponse(raw, "gemini");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "c1", name: "f", arguments: { a: 1 }, argumentsText: '{"a":1}' }]);
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10, cachedInputTokens: 4 });
  });

  it("synthesizes a tool-call id when Gemini omits one", () => {
    const raw = { candidates: [{ content: { parts: [{ functionCall: { name: "f", args: {} } }] } }] };
    const result = parseGoogleResponse(raw, "gemini");
    expect(result.toolCalls[0]?.id).toBe("call_f_0");
  });
});

describe("translateGoogleStream", () => {
  it("emits start/delta/end per whole functionCall and a final finish", async () => {
    const events = await collect(
      translateGoogleStream(
        sseMessages(
          { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) },
          { data: JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) },
        ),
        "gemini",
      ),
    );
    expect(events).toEqual([
      { type: "message_start", model: "gemini" },
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", index: 0, id: "c1", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"a":1}' },
      { type: "tool_call_end", index: 0 },
      { type: "finish", finishReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
  });
});
