/**
 * `defineAgent` — the ergonomic constructor for {@link AgentDefinition}s.
 *
 * Pure and fail-fast: it validates the agent's `name` and eagerly builds a
 * {@link ToolRegistry} so duplicate tool names are caught at definition time
 * (an `ExecutionError`) rather than mid-run. It returns the definition as data;
 * running it is Phase 4's job.
 *
 * @example
 * ```ts
 * import { defineAgent } from "engine-lib/agent";
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
