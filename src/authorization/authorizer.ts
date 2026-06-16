import type { Message } from "../messages/types";

export type ToolAuthorization =
  | { readonly allowed: true; readonly argumentsOverride?: unknown }
  | { readonly allowed: false; readonly reason: string };

export interface ToolAuthorizationContext {
  readonly name: string;
  readonly arguments: unknown;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly principal?: string;
  readonly roles?: readonly string[];
  readonly messages: readonly Message[];
}

export interface ToolAuthorizer {
  authorize(
    call: { readonly name: string; readonly arguments: unknown },
    ctx: ToolAuthorizationContext,
  ): ToolAuthorization | Promise<ToolAuthorization>;
}

export function roleToolAuthorizer(opts: {
  readonly allow: Readonly<Record<string, readonly string[]>>;
  readonly agents?: Readonly<Record<string, readonly string[]>>;
}): ToolAuthorizer {
  return {
    authorize(call, ctx): ToolAuthorization {
      // N24: per-agent allowlist — when present, agent-scoped check runs first.
      if (opts.agents !== undefined) {
        const agentTools = opts.agents[ctx.agentName];
        if (agentTools !== undefined && !agentTools.includes(call.name)) {
          return {
            allowed: false,
            reason: `tool "${call.name}" is not permitted for agent "${ctx.agentName}"`,
          };
        }
      }
      const roles = ctx.roles ?? [];
      for (const role of roles) {
        const allowed = opts.allow[role];
        if (allowed?.includes(call.name)) return { allowed: true };
      }
      return {
        allowed: false,
        reason: `tool "${call.name}" is not permitted for current roles`,
      };
    },
  };
}
