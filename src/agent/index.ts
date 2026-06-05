/**
 * `engine-lib/agent` — the agent contract: declarative {@link AgentDefinition}s,
 * the {@link defineAgent} constructor, and the per-agent {@link ToolRegistry}.
 *
 * Re-exports the tool contract too, so the common path (define a tool, define an
 * agent) is reachable from a single import.
 *
 * @module
 */

export { defineAgent } from "./define";
export { createToolRegistry } from "./registry";
export type { ToolRegistry } from "./registry";
export { createAgentRegistry } from "./agent-registry";
export type { AgentRegistry } from "./agent-registry";
export { asTool } from "./as-tool";
export type { AsToolOptions } from "./as-tool";

export type {
  AgentDefinition,
  AgentHooks,
  GenerationSettings,
  InstructionContext,
  Instructions,
} from "./types";

// Re-export the tool layer for convenience.
export { defineTool, renderToolContent, toProviderTool, toToolResultMessage } from "../tools/index";
export type {
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolResult,
  ToolSpec,
  ToolSuccess,
} from "../tools/index";
