/**
 * Handoff / delegation helpers (Phase 7).
 *
 * A handoff lets one agent transfer the running conversation to another
 * (triage → specialist) while keeping the message history intact. Rather than
 * inventing a new protocol, each declared {@link AgentDefinition.handoffs}
 * target is surfaced to the model as a synthetic `transfer_to_<name>` tool
 * (Principle 1, provider-native): when the model calls it, the run loop
 * acknowledges the tool call, emits `agent.handoff`, and switches the *active
 * agent* instead of dispatching a normal tool.
 *
 * This module only computes the synthetic toolset and resolves targets; the
 * active-agent switch lives in the run loop (`executeAgent`).
 *
 * @module
 */

import { ExecutionError } from "../errors";
import type { ProviderTool } from "../providers/types";
import { s } from "../schema/index";
import type { AgentRegistry } from "./agent-registry";
import type { AgentDefinition } from "./types";

/** Prefix for the synthetic tools the loop advertises for an agent's handoffs. */
export const HANDOFF_TOOL_PREFIX = "transfer_to_";

/** The synthetic transfer-tool name for a target agent. */
export function handoffToolName(agentName: string): string {
  return `${HANDOFF_TOOL_PREFIX}${agentName}`;
}

/** Empty-args JSON schema for the synthetic transfer tools. */
const HANDOFF_PARAMETERS = s.object({}).jsonSchema;

/**
 * Resolve an agent's declared {@link AgentDefinition.handoffs} into a map keyed
 * by synthetic transfer-tool name (`transfer_to_<name>`). String targets are
 * resolved through `registry`.
 *
 * @throws {ExecutionError} if a string target is declared without a registry,
 *   the target name is unknown, or two targets resolve to the same name. The
 *   run loop also rejects synthetic handoff tool names that collide with a real
 *   tool on the same agent.
 */
export function resolveHandoffTargets(
  agent: AgentDefinition,
  registry?: AgentRegistry,
): Map<string, AgentDefinition> {
  const targets = new Map<string, AgentDefinition>();
  for (const entry of agent.handoffs ?? []) {
    const target =
      typeof entry === "string" ? resolveByName(agent, entry, registry) : entry;
    const toolName = handoffToolName(target.name);
    if (targets.has(toolName)) {
      throw new ExecutionError(
        `agent "${agent.name}" declares duplicate handoff target "${target.name}"`,
      );
    }
    targets.set(toolName, target);
  }
  return targets;
}

function resolveByName(
  agent: AgentDefinition,
  name: string,
  registry?: AgentRegistry,
): AgentDefinition {
  if (registry === undefined) {
    throw new ExecutionError(
      `agent "${agent.name}" declares a string handoff "${name}" but no registry was ` +
        `provided; pass { registry } to runAgent or use a direct AgentDefinition target`,
    );
  }
  return registry.resolve(name);
}

/**
 * Synthesize the provider-advertised transfer tools for a resolved target map
 * (as produced by {@link resolveHandoffTargets}).
 */
export function handoffProviderTools(
  targets: ReadonlyMap<string, AgentDefinition>,
): ProviderTool[] {
  return [...targets.entries()].map(([toolName, target]) => ({
    name: toolName,
    description:
      `Transfer the conversation to the "${target.name}" agent. ` +
      `Use this when the request is better handled by that agent; ` +
      `the full message history is preserved.`,
    parameters: HANDOFF_PARAMETERS,
  }));
}
