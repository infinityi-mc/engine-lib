/**
 * The per-agent tool registry.
 *
 * A {@link ToolRegistry} provides name-based lookup over an agent's toolset and
 * generates the provider-facing JSON-Schema toolset. It is built eagerly so
 * duplicate tool names fail fast (a configuration bug), rather than surfacing as
 * a confusing mid-run dispatch error.
 *
 * @module
 */

import { ExecutionError } from "../errors";
import type { ProviderTool } from "../providers/types";
import { toProviderTool } from "../tools/result";
import type { ToolDefinition } from "../tools/types";

/** Name-based lookup over a toolset, plus provider-toolset generation. */
export interface ToolRegistry {
  readonly size: number;
  has(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  /** Project every tool into a Phase-2 {@link ProviderTool}, preserving order. */
  toProviderTools(): ProviderTool[];
}

/**
 * Build a {@link ToolRegistry} from a toolset.
 *
 * @throws {ExecutionError} if two tools share a name.
 */
export function createToolRegistry(
  tools: readonly ToolDefinition[],
): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  const ordered: ToolDefinition[] = [];

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new ExecutionError(`duplicate tool name: "${tool.name}"`);
    }
    byName.set(tool.name, tool);
    ordered.push(tool);
  }

  return {
    get size() {
      return ordered.length;
    },
    has(name: string): boolean {
      return byName.has(name);
    },
    get(name: string): ToolDefinition | undefined {
      return byName.get(name);
    },
    list(): readonly ToolDefinition[] {
      return ordered;
    },
    toProviderTools(): ProviderTool[] {
      return ordered.map(toProviderTool);
    },
  };
}
