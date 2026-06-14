import { describe, expect, it } from "bun:test";

import { defineAgent, defineTool } from "../src/agent/index";
import {
  TRUST_METADATA_KEY,
  askHumanTool,
  deferredHumanInputGateway,
  trustApprovalPolicy,
} from "../src/approval/index";
import {
  BudgetExceededError,
  CancelledError,
  ProviderError,
} from "../src/errors";
import { runAgent, type RunEvent } from "../src/execution/index";
import type { Message } from "../src/messages/types";
import { toProviderError } from "../src/providers/http";
import type { CompletionRequest, Provider } from "../src/providers/types";
import { regexRedactor } from "../src/governance/index";
import { circuitBreaker, withProviderRetry } from "../src/resilience/index";
import { s } from "../src/schema/index";
import { mockProvider, textResult, toolCallResult } from "../src/testing/index";

function textOf(message: Message): string {
  return message.content
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "tool_result") return part.content.map((p) => p.text);
      return [];
    })
    .join("");
}

function scriptedProvider(results: readonly ReturnType<typeof textResult>[]) {
  let i = 0;
  return mockProvider({
    result: () => results[Math.min(i++, results.length - 1)]!,
  });
}

describe("production readiness Phase 1", () => {
  it("denies approved-gated tool calls as tool failures without executing", async () => {
    let executed = false;
    const tool = defineTool({
      name: "danger",
      parameters: s.object({ secret: s.string() }),
      execute: () => {
        executed = true;
        return { ok: true, content: "ran" };
      },
    });
    const events: RunEvent[] = [];
    const agent = defineAgent({
      name: "phase1",
      tools: [tool],
      provider: scriptedProvider([
        toolCallResult([
          { id: "c1", name: "danger", arguments: { secret: "do-not-log" } },
        ]),
        textResult("recovered"),
      ]),
    });

    const result = await runAgent(agent, {
      input: "go",
      approval: {
        requiresApproval: () => true,
        decide: () => ({ approved: false, reason: "blocked" }),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.output).toBe("recovered");
    expect(executed).toBe(false);
    const toolMessage = result.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content[0]).toMatchObject({ isError: true });
    expect(textOf(toolMessage!)).toContain("blocked");
    const approvalRequested = events.find(
      (
        event,
      ): event is Extract<RunEvent, { type: "tool.approval_requested" }> =>
        event.type === "tool.approval_requested",
    );
    expect(approvalRequested?.argumentsDigest).toMatch(/^sha256:/);
    expect(JSON.stringify(approvalRequested)).not.toContain("do-not-log");
    expect(events.some((event) => event.type === "tool.approval_decided")).toBe(
      true,
    );
  });

  it("resolves ask_human through the deferred gateway", async () => {
    const gateway = deferredHumanInputGateway();
    const events: RunEvent[] = [];
    const agent = defineAgent({
      name: "phase1",
      tools: [askHumanTool()],
      provider: scriptedProvider([
        toolCallResult([
          { id: "h1", name: "ask_human", arguments: { question: "Continue?" } },
        ]),
        textResult("done"),
      ]),
    });

    const run = runAgent(agent, {
      input: "go",
      humanInput: gateway,
      onEvent: (event) => events.push(event),
    });
    while (gateway.pending().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    gateway.resolve(gateway.pending()[0]!.requestId, "yes");

    const result = await run;
    expect(result.output).toBe("done");
    expect(
      result.messages.some(
        (message) => message.role === "tool" && textOf(message) === "yes",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "human.input_requested")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "human.input_provided")).toBe(
      true,
    );
  });

  it("emits human-input cancellation events before aborting the run", async () => {
    const gateway = deferredHumanInputGateway();
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const agent = defineAgent({
      name: "phase1",
      tools: [askHumanTool()],
      provider: scriptedProvider([
        toolCallResult([
          { id: "h1", name: "ask_human", arguments: { question: "Continue?" } },
        ]),
      ]),
    });

    const run = runAgent(agent, {
      input: "go",
      humanInput: gateway,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    while (gateway.pending().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(events.some((event) => event.type === "human.input_requested")).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === "human.input_provided" && event.cancelled === true,
      ),
    ).toBe(true);
  });

  it("throws BudgetExceededError after a provider turn exceeds a stop budget", async () => {
    const agent = defineAgent({
      name: "phase1",
      provider: scriptedProvider([
        textResult("expensive", {
          inputTokens: 60,
          outputTokens: 50,
          totalTokens: 110,
        }),
      ]),
    });

    await expect(
      runAgent(agent, {
        input: "go",
        budget: { maxTotalTokens: 100 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("emits retry and rate-limit events around provider calls", async () => {
    let attempts = 0;
    const provider: Provider = {
      ...mockProvider(),
      async complete() {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderError("temporary", {
            provider: "mock",
            status: 503,
          });
        }
        return textResult("ok");
      },
    };
    const events: RunEvent[] = [];
    const agent = defineAgent({ name: "phase1", provider });

    const result = await runAgent(agent, {
      input: "go",
      retry: { maxRetries: 2, backoffMs: 0 },
      rateLimiter: {
        async acquire() {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.output).toBe("ok");
    expect(attempts).toBe(3);
    expect(
      events.filter((event) => event.type === "provider.retry"),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "rate_limit.wait")).toBe(true);
  });

  it("does not open the circuit breaker on non-retryable provider errors", async () => {
    let attempts = 0;
    const provider: Provider = {
      ...mockProvider(),
      async complete() {
        attempts += 1;
        throw new ProviderError("unauthorized", {
          provider: "mock",
          status: 401,
          retryable: false,
        });
      },
    };
    const protectedProvider = circuitBreaker(provider, {
      failureThreshold: 1,
      cooldownMs: 1_000,
    });

    await expect(protectedProvider.complete({ messages: [] })).rejects.toThrow(
      "unauthorized",
    );
    await expect(protectedProvider.complete({ messages: [] })).rejects.toThrow(
      "unauthorized",
    );
    expect(attempts).toBe(2);
  });

  it("uses the same retryability fallback for HTTP-wrapped and manual provider errors", async () => {
    let httpAttempts = 0;
    await expect(
      withProviderRetry(
        async () => {
          httpAttempts += 1;
          throw toProviderError(
            "mock",
            Object.assign(new Error("not implemented"), { status: 501 }),
          );
        },
        { maxRetries: 1, backoffMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(httpAttempts).toBe(1);

    let manualAttempts = 0;
    await expect(
      withProviderRetry(
        async () => {
          manualAttempts += 1;
          throw new ProviderError("not implemented", {
            provider: "mock",
            status: 501,
          });
        },
        { maxRetries: 1, backoffMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(manualAttempts).toBe(1);
  });

  it("serializes concurrent session trust elevations", async () => {
    let metadata: Record<string, unknown> = {};
    const session = {
      id: "trust-session",
      messages: async () => [],
      append: async () => ({}),
      clear: async () => {},
      getMetadata: async () => metadata,
      setMetadata: async (next: Record<string, unknown>) => {
        const trust = next[TRUST_METADATA_KEY] as
          | { readonly grantedLevel?: unknown }
          | undefined;
        if (trust?.grantedLevel === "low") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        metadata = next;
      },
    };
    const policy = trustApprovalPolicy({
      session,
      classify: () => "high",
      prompt: (req) => ({
        approved: true,
        grant: {
          level: req.name === "low" ? "low" : "high",
          scope: "session",
        },
      }),
      maxAutoApprove: "high",
    });
    const baseReq = {
      toolCallId: "c",
      arguments: {},
      agentName: "phase1",
      messages: [],
      pendingCalls: [],
      sessionId: session.id,
    };

    await Promise.all([
      policy.decide({ ...baseReq, name: "low" }, {}),
      policy.decide({ ...baseReq, name: "high" }, {}),
    ]);

    expect(
      (metadata[TRUST_METADATA_KEY] as { readonly grantedLevel?: unknown })
        .grantedLevel,
    ).toBe("high");
  });

  it("filters provider input view and tool output without mutating canonical input", async () => {
    const requests: CompletionRequest[] = [];
    let step = 0;
    const piiTool = defineTool({
      name: "pii",
      parameters: s.object({}),
      execute: () => ({ ok: true, content: "SSN 123-45-6789" }),
    });
    const agent = defineAgent({
      name: "phase1",
      tools: [piiTool],
      provider: mockProvider({
        onRequest: (req) => requests.push(req),
        result: () => {
          step += 1;
          return step === 1
            ? toolCallResult([{ id: "p1", name: "pii", arguments: {} }])
            : textResult("done");
        },
      }),
    });

    const result = await runAgent(agent, {
      input: "email me at person@example.com",
      filters: {
        providerInput: [
          regexRedactor([
            {
              pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
              replacement: "[EMAIL]",
            },
          ]),
        ],
        toolOutput: [
          regexRedactor([
            { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
          ]),
        ],
      },
    });

    expect(textOf(requests[0]!.messages.at(-1)!)).toContain("[EMAIL]");
    expect(textOf(result.messages[0]!)).toContain("person@example.com");
    const toolMessage = result.messages.find(
      (message) => message.role === "tool",
    );
    expect(textOf(toolMessage!)).toContain("[SSN]");
    expect(
      textOf(requests[1]!.messages.find((message) => message.role === "tool")!),
    ).toContain("[SSN]");
  });
});
