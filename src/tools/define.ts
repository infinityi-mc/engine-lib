/**
 * `defineTool` — the ergonomic constructor for {@link ToolDefinition}s.
 *
 * Application code should prefer this constructor over hand-writing
 * `ToolDefinition` objects. The argument type `TArgs` is inferred from the
 * parameter schema (`parameters: Schema<TArgs>`), so `execute` receives
 * fully-typed, already-validated arguments with zero annotations.
 *
 * @example
 * ```ts
 * import { s } from "@infinityi/engine-lib/schema";
 * import { defineTool } from "@infinityi/engine-lib/tools";
 *
 * const readFile = defineTool({
 *   name: "read_file",
 *   description: "Read a file from the workspace.",
 *   parameters: s.object({ path: s.string() }),
 *   execute: async ({ path }) => ({ ok: true, content: await workspace.read(path) }),
 * });
 * ```
 *
 * @module
 */

import type { Schema } from "../schema/types";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/** The shape passed to {@link defineTool}, with `execute` typed against the schema. */
export interface ToolSpec<TArgs> {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Schema<TArgs>;
  execute(args: TArgs, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

/**
 * Define a tool with argument types inferred from its parameter schema.
 *
 * Pure: validates that `name` is non-empty and returns a frozen
 * {@link ToolDefinition}. No execution or registration happens here. Return
 * `{ ok: false, error }` for expected/domain failures; reserve thrown errors
 * for unexpected implementation faults. `runAgent` isolates both forms as tool
 * results so one bad tool call does not crash the whole run.
 */
export function defineTool<TArgs>(
  spec: ToolSpec<TArgs>,
): ToolDefinition<TArgs> {
  if (typeof spec.name !== "string" || spec.name.trim() === "") {
    throw new TypeError("defineTool: `name` must be a non-empty string");
  }
  const tool: ToolDefinition<TArgs> = {
    name: spec.name,
    ...(spec.description !== undefined
      ? { description: spec.description }
      : {}),
    parameters: spec.parameters,
    execute: spec.execute,
  };
  return Object.freeze(tool);
}
