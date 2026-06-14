import type { Message } from "../messages/types";
import type { EngineContext } from "../runtime/types";

export type TrustLevel = "none" | "low" | "medium" | "high";

export interface ApprovalGrant {
  readonly level: TrustLevel;
  readonly scope: "session";
}

/** A host's decision for a tool call approval request. */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly grant?: ApprovalGrant;
  /** `false` keeps the grant single-use and avoids raising session trust. */
  readonly remember?: boolean;
}

export interface ApprovalPendingCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agentName: string;
  readonly messages: readonly Message[];
  readonly pendingCalls: readonly ApprovalPendingCall[];
  readonly sessionId?: string;
}

/** Gate consulted by the run loop before regular tool execution. */
export interface ApprovalPolicy {
  requiresApproval(
    req: ApprovalRequest,
    ctx: EngineContext,
  ): boolean | Promise<boolean>;
  decide(
    req: ApprovalRequest,
    ctx: EngineContext,
  ): ApprovalDecision | Promise<ApprovalDecision>;
}

export interface HumanInputRequest {
  readonly requestId: string;
  readonly question: string;
  readonly context?: string;
  readonly agentName: string;
  readonly toolCallId: string;
  readonly sessionId?: string;
}

export interface HumanInputGateway {
  request(req: HumanInputRequest, ctx: EngineContext): Promise<string>;
}
