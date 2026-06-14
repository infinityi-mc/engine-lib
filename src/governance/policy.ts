import type { Message } from "../messages/types";
import type { ApprovalRequest } from "../approval/types";
import type { ShellPolicy, CommandPattern } from "../tools-shell/types";
import type { HttpToolsConfig } from "../tools-http/types";
import type { FilesystemToolsConfig } from "../tools-fs/types";
import { classifyCommand } from "../tools-shell/policy";
import { assertUrlAllowed, normalizeHttpConfig } from "../tools-http/policy";
import {
  normalizeFilesystemPolicy,
  resolvePath,
  FilesystemAccessError,
} from "../tools-fs/policy";

export interface PolicyAction {
  readonly tool: string;
  readonly operation:
    | "read"
    | "write"
    | "delete"
    | "network"
    | "exec"
    | string;
  readonly target: string;
  readonly arguments: unknown;
}

export interface PolicyContext {
  readonly agentName: string;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly principal?: string;
  readonly messages: readonly Message[];
}

export type PolicyDecision =
  | {
      readonly allowed: true;
      readonly transformArguments?: unknown;
      readonly requiresApproval?: boolean;
    }
  | { readonly allowed: false; readonly reason: string };

export interface PolicyEngine {
  evaluate(
    action: PolicyAction,
    ctx: PolicyContext,
  ): PolicyDecision | Promise<PolicyDecision>;
}

export interface PolicyDecisionEvent {
  readonly toolCallId: string;
  readonly name: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly requiresApproval?: boolean;
  readonly transformed?: boolean;
  readonly argumentsDigest: string;
}

interface ShellPolicyLike {
  readonly allow?: readonly CommandPattern[];
  readonly deny?: readonly CommandPattern[];
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: unknown, key: string): value is Record<string, string> {
  return isRecord(value) && typeof value[key] === "string";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function inferTarget(args: unknown, fallback: string): string {
  if (typeof args === "object" && args !== null) {
    const url = (args as { readonly url?: unknown }).url;
    if (typeof url === "string") return url;
    const command = (args as { readonly command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return fallback;
}

export function composePolicies(
  ...engines: readonly PolicyEngine[]
): PolicyEngine {
  return {
    async evaluate(action, ctx): Promise<PolicyDecision> {
      let sawApproval = false;
      let transformed: unknown = action.arguments;
      let target = action.target;
      let changed = false;
      for (const engine of engines) {
        const nextAction =
          changed && transformed !== action.arguments
            ? { ...action, arguments: transformed, target }
            : action;
        const decision = await engine.evaluate(nextAction, ctx);
        if (!decision.allowed) return decision;
        if ("transformArguments" in decision && decision.transformArguments !== undefined) {
          transformed = decision.transformArguments;
          target = inferTarget(transformed, target);
          changed = true;
        }
        if ("requiresApproval" in decision && decision.requiresApproval) {
          sawApproval = true;
        }
      }
      if (changed || sawApproval) {
        return {
          allowed: true,
          ...(changed ? { transformArguments: transformed } : {}),
          ...(sawApproval ? { requiresApproval: true } : {}),
        };
      }
      return { allowed: true };
    },
  };
}

export function shellPolicySource(config?: ShellPolicyLike): PolicyEngine {
  return {
    evaluate(action): PolicyDecision {
      if (action.operation !== "exec") return { allowed: true };
      const args = isRecord(action.arguments) ? action.arguments : {};
      const command = (hasString(args, "command") ? args.command : action.target) as string;
      const argv = stringArray(args.args);
      const verdict = classifyCommand(command, argv, config as ShellPolicy);
      return verdict.allowed
        ? { allowed: true }
        : deny(verdict.reason ?? "command denied by policy");
    },
  };
}

export function httpPolicySource(config: HttpToolsConfig): PolicyEngine {
  const normalized = normalizeHttpConfig(config);
  return {
    evaluate(action): PolicyDecision {
      if (action.operation !== "network") return { allowed: true };
      try {
        assertUrlAllowed(new URL(action.target), normalized);
        return { allowed: true };
      } catch (error) {
        return deny(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function filesystemPolicySource(
  config: FilesystemToolsConfig,
): PolicyEngine {
  const policy = normalizeFilesystemPolicy(config);
  return {
    async evaluate(action): Promise<PolicyDecision> {
      const op = action.operation;
      if (op !== "read" && op !== "write" && op !== "delete") {
        return { allowed: true };
      }
      try {
        await resolvePath(policy, action.target, {
          mustExist: op === "read",
          forCreate: op === "write",
        });
        return { allowed: true };
      } catch (error) {
        if (error instanceof FilesystemAccessError) return deny(error.message);
        return deny(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function approvalDecisionFromPolicy(
  decision: PolicyDecision,
): boolean {
  return "requiresApproval" in decision && decision.requiresApproval === true;
}

export function approvalRequestFromPolicy(
  req: ApprovalRequest,
): PolicyContext {
  return {
    agentName: req.agentName,
    ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
    messages: req.messages,
  };
}
