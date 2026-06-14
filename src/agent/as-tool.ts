/**
 * `asTool` — wrap an {@link AgentDefinition} as a {@link ToolDefinition} so a
 * parent agent can invoke it through the normal provider-native tool-calling
 * path (the "sub-agent-as-tool" pattern, Phase 7).
 *
 * The returned tool runs the child agent with {@link runAgent} (buffered) and
 * returns its final text as the tool result. When dispatched inside a run, the
 * child's events and token usage are propagated to the parent run through
 * the {@link ToolContext.run} bridge: each child {@link RunEvent} is re-emitted
 * as an `agent.child` event, and the child's usage is folded into the parent's
 * aggregate. A failing child run (a thrown {@link AgentError}) becomes a tool
 * error fed back to the parent model — never an unhandled throw.
 *
 * @example
 * ```ts
 * import { asTool, defineAgent } from "@infinityi/engine-lib/agent";
 *
 * const researcher = defineAgent({ name: "researcher", provider, instructions: "…" });
 * const lead = defineAgent({
 *   name: "lead",
 *   provider,
 *   tools: [asTool(researcher, { description: "Delegate research to a specialist." })],
 * });
 * ```
 *
 * @module
 */

import { AgentError } from "../errors";
import { runAgent } from "../execution/run";
import type { RunEvent, RunInput } from "../execution/types";
import { s } from "../schema/builder";
import type { Schema } from "../schema/types";
import { defineTool } from "../tools/define";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";
import type { AgentDefinition } from "./types";

/** Default parameter schema for a sub-agent tool: a single `input` string. */
const DEFAULT_PARAMETERS = s.object({ input: s.string() });

/** Options for {@link asTool}. */
export interface AsToolOptions<TArgs = { input: string }> {
  /** Tool name advertised to the parent model. Defaults to the agent's name. */
  readonly name?: string;
  /** Tool description. Defaults to a generic "delegate to <agent>" line. */
  readonly description?: string;
  /**
   * Parameter schema for the tool. Defaults to `{ input: string }`. When you
   * supply a custom schema, also supply {@link AsToolOptions.toInput} to map the
   * validated arguments into the child run's input.
   */
  readonly parameters?: Schema<TArgs>;
  /**
   * Map the validated tool arguments to the child run's {@link RunInput}.
   * Defaults to using `args.input` (matching the default schema).
   */
  readonly toInput?: (args: TArgs) => RunInput;
}

/** Nesting depth for a forwarded child event (flattened: a child of a child is depth 2, …). */
function childDepth(event: RunEvent): number {
  return event.type === "agent.child" ? event.depth + 1 : 1;
}

/**
 * Wrap `agent` as a {@link ToolDefinition} the parent agent can call.
 *
 * The tool's `execute` runs `agent` to completion, threading the parent's
 * telemetry / logger / abort signal through, propagating the child's events and
 * usage to the parent run, and returning the child's final output as content.
 * The default tool schema is `{ input: string }`; custom schemas should provide
 * `toInput` so validated tool arguments can be converted into the child run's
 * `RunInput`.
 */
export function asTool<TArgs = { input: string }>(
  agent: AgentDefinition,
  opts: AsToolOptions<TArgs> = {},
): ToolDefinition<TArgs> {
  const parameters = (opts.parameters ??
    DEFAULT_PARAMETERS) as unknown as Schema<TArgs>;
  const toInput =
    opts.toInput ?? ((args: TArgs) => (args as { input: string }).input);

  return defineTool<TArgs>({
    name: opts.name ?? agent.name,
    description:
      opts.description ?? `Delegate the task to the "${agent.name}" agent.`,
    parameters,
    execute: async (args: TArgs, ctx: ToolContext): Promise<ToolResult> => {
      const bridge = ctx.run;
      try {
        const result = await runAgent(agent, {
          input: toInput(args),
          ...(ctx.telemetry !== undefined ? { telemetry: ctx.telemetry } : {}),
          ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          ...(bridge !== undefined
            ? {
                onEvent: (event: RunEvent) =>
                  bridge.emit({
                    type: "agent.child",
                    agent: agent.name,
                    depth: childDepth(event),
                    event,
                  }),
              }
            : {}),
        });
        bridge?.reportUsage(result.usage);
        return { ok: true, content: result.output };
      } catch (err) {
        // A failed child run still consumed tokens; fold whatever it stamped on
        // the error into the parent's usage before surfacing the tool error.
        if (err instanceof AgentError && err.usage !== undefined) {
          bridge?.reportUsage(err.usage);
        }
        const message = err instanceof AgentError ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  });
}
