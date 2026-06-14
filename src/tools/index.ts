/**
 * `@infinityi/engine-lib/tools` — the tool contract: declarative tool definitions, the
 * structured tool-result model, and the mappers that connect tools to the
 * conversation model (Phase 1) and the provider toolset (Phase 2).
 *
 * @module
 */

export { defineTool } from "./define";
export type { ToolSpec } from "./define";

export {
  renderToolContent,
  toProviderTool,
  toToolResultMessage,
} from "./result";

export type {
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolResult,
  ToolSuccess,
} from "./types";
