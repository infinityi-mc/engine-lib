import { CancelledError } from "../errors";
import { s } from "../schema/builder";
import { defineTool } from "../tools/define";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";
import type { EngineContext } from "../runtime/types";
import type { HumanInputGateway, HumanInputRequest } from "./types";

export interface AskHumanConfig {
  readonly name?: string;
  readonly description?: string;
}

export interface DeferredHumanInputGateway extends HumanInputGateway {
  resolve(requestId: string, answer: string): void;
  reject(requestId: string, reason?: string): void;
  pending(): readonly HumanInputRequest[];
}

const ASK_HUMAN_PARAMS = s.object({
  question: s.string({ description: "Question to ask the human operator." }),
  context: s.optional(
    s.string({ description: "Optional extra context for the human operator." }),
  ),
});

type AskHumanArgs = {
  readonly question: string;
  readonly context?: string;
};

function newRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto !== undefined && "randomUUID" in crypto) {
    return `human_${crypto.randomUUID()}`;
  }
  return `human_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): CancelledError {
  return new CancelledError("human input cancelled");
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
      return;
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function askHumanTool(config: AskHumanConfig = {}): ToolDefinition {
  return defineTool({
    name: config.name ?? "ask_human",
    description:
      config.description ??
      "Ask a human operator a question and wait for their answer.",
    parameters: ASK_HUMAN_PARAMS,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = rawArgs as AskHumanArgs;
      if (ctx.humanInput === undefined) {
        return { ok: false, error: "no human-input gateway configured" };
      }

      const request: HumanInputRequest = {
        requestId: newRequestId(),
        question: args.question,
        ...(args.context !== undefined ? { context: args.context } : {}),
        agentName: ctx.agentName ?? "unknown",
        toolCallId: ctx.toolCallId,
      };

      ctx.run?.emit({
        type: "human.input_requested",
        requestId: request.requestId,
        question: request.question,
        ...(request.context !== undefined ? { context: request.context } : {}),
      });

      try {
        const answer = await withAbort(
          ctx.humanInput.request(request, ctx),
          ctx.signal,
        );
        ctx.run?.emit({
          type: "human.input_provided",
          requestId: request.requestId,
          cancelled: false,
        });
        return { ok: true, content: answer };
      } catch (error) {
        const cancelled =
          error instanceof CancelledError || ctx.signal?.aborted === true;
        ctx.run?.emit({
          type: "human.input_provided",
          requestId: request.requestId,
          cancelled,
        });
        if (cancelled) throw error;
        return { ok: false, error: messageOf(error) };
      }
    },
  });
}

interface PendingRequest {
  readonly request: HumanInputRequest;
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export function deferredHumanInputGateway(): DeferredHumanInputGateway {
  const pending = new Map<string, PendingRequest>();

  return {
    request(req: HumanInputRequest, ctx: EngineContext): Promise<string> {
      if (ctx.signal?.aborted) return Promise.reject(abortError());
      return new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          ctx.signal?.removeEventListener("abort", onAbort);
          pending.delete(req.requestId);
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal?.aborted) {
          cleanup();
          reject(abortError());
          return;
        }
        pending.set(req.requestId, {
          request: req,
          resolve: (answer) => {
            cleanup();
            resolve(answer);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
          cleanup,
        });
      });
    },
    resolve(requestId: string, answer: string): void {
      pending.get(requestId)?.resolve(answer);
    },
    reject(requestId: string, reason = "human input rejected"): void {
      pending.get(requestId)?.reject(new Error(reason));
    },
    pending(): readonly HumanInputRequest[] {
      return [...pending.values()].map((entry) => entry.request);
    },
  };
}
