/**
 * `defineAgent` — the ergonomic constructor for {@link AgentDefinition}s.
 *
 * Application code should prefer this constructor over hand-writing
 * `AgentDefinition` objects. Pure and fail-fast: it validates the agent's
 * `name` and eagerly builds a {@link ToolRegistry} so duplicate tool names are
 * caught at definition time (an `ExecutionError`) rather than mid-run. It
 * returns the definition as data; running it is `runAgent`'s job.
 *
 * @example
 * ```ts
 * import { defineAgent } from "@infinityi/engine-lib/agent";
 *
 * const coder = defineAgent({
 *   name: "terminal-coder",
 *   provider,
 *   instructions: "You are a coding assistant operating inside the user's terminal.",
 *   tools: [readFile, runCommand],
 * });
 * ```
 *
 * @module
 */

import { createToolRegistry } from "./registry";
import type { AgentDefinition } from "./types";

/**
 * Define an agent, validating its name and tool-name uniqueness.
 *
 * Instructions, hooks, handoffs, and generation settings are stored as data and
 * resolved by the run loop. No provider calls, context resolution, or registry
 * lookup happens here.
 *
 * @throws {TypeError} if `name` is missing/empty.
 * @throws {ExecutionError} if two tools share a name.
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  if (typeof def.name !== "string" || def.name.trim() === "") {
    throw new TypeError("defineAgent: `name` must be a non-empty string");
  }
  // Build the registry purely for its eager collision check; the run loop
  // (Phase 4) reconstructs it from the returned `tools`.
  createToolRegistry(def.tools ?? []);
  return def;
}
