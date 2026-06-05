/**
 * An opt-in, named-lookup registry for {@link AgentDefinition}s.
 *
 * Multi-agent coordination (Phase 7) needs a way to resolve an agent *by name* —
 * a string-named {@link AgentDefinition.handoffs handoff} target, or a host that
 * discovers agents dynamically. An {@link AgentRegistry} provides that lookup
 * without introducing global state: it is created explicitly and held by the
 * host (Design Principle 7, "no global agent registry by default"). It mirrors
 * the per-agent {@link ToolRegistry}: built eagerly so duplicate agent names
 * fail fast (a configuration bug) rather than surfacing as a confusing
 * resolution error later.
 *
 * @module
 */

import { ExecutionError } from "../errors";
import type { AgentDefinition } from "./types";

/** Name-based lookup over a set of {@link AgentDefinition}s. */
export interface AgentRegistry {
  /** Number of registered agents. */
  readonly size: number;
  /** Whether an agent with this name is registered. */
  has(name: string): boolean;
  /** Get an agent by name, or `undefined` if absent. */
  get(name: string): AgentDefinition | undefined;
  /**
   * Get an agent by name, throwing if it is not registered.
   *
   * @throws {ExecutionError} if no agent with `name` is registered.
   */
  resolve(name: string): AgentDefinition;
  /** A snapshot of every registered agent, in registration order. */
  list(): readonly AgentDefinition[];
  /**
   * Register an additional agent.
   *
   * @throws {ExecutionError} if an agent with the same name is already registered.
   */
  register(agent: AgentDefinition): void;
}

/**
 * Build an {@link AgentRegistry}, optionally seeded with `agents`.
 *
 * @throws {ExecutionError} if two agents share a name.
 */
export function createAgentRegistry(
  agents: readonly AgentDefinition[] = [],
): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  const ordered: AgentDefinition[] = [];

  const register = (agent: AgentDefinition): void => {
    if (byName.has(agent.name)) {
      throw new ExecutionError(`duplicate agent name: "${agent.name}"`);
    }
    byName.set(agent.name, agent);
    ordered.push(agent);
  };

  for (const agent of agents) register(agent);

  return {
    get size() {
      return ordered.length;
    },
    has(name: string): boolean {
      return byName.has(name);
    },
    get(name: string): AgentDefinition | undefined {
      return byName.get(name);
    },
    resolve(name: string): AgentDefinition {
      const agent = byName.get(name);
      if (agent === undefined) {
        throw new ExecutionError(`unknown agent: "${name}"`);
      }
      return agent;
    },
    list(): readonly AgentDefinition[] {
      // Copy so a snapshot is not mutated by a later register().
      return [...ordered];
    },
    register,
  };
}
