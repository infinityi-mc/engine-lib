/**
 * Built-in {@link ContextProvider}s and the resolver that turns them into the
 * system messages injected at the head of a run. Context providers are resolved
 * once per run, before the first provider call; their output is never persisted
 * to a session.
 *
 * @module
 */

import { system } from "../messages/factory";
import type { Message } from "../messages/types";
import type { EngineContext } from "../runtime/types";
import type {
  ContextItem,
  ContextProvider,
  ContextResolveContext,
} from "./types";

/** Render one {@link ContextItem} to text (strings pass through; else JSON). */
function renderItem(item: ContextItem): string {
  // JSON.stringify(undefined) returns the value `undefined`, not a string — coerce to "".
  const body =
    typeof item.content === "string"
      ? item.content
      : (JSON.stringify(item.content, null, 2) ?? "");
  return item.title !== undefined && item.title !== ""
    ? `## ${item.title}\n${body}`
    : body;
}

/**
 * Inject static facts verbatim. `content` is rendered as-is (strings) or
 * JSON-encoded; an optional `title` becomes a markdown heading.
 */
export function staticContext(
  content: unknown,
  title?: string,
): ContextProvider {
  const item: ContextItem = {
    content,
    ...(title !== undefined ? { title } : {}),
  };
  return {
    name: "static",
    resolve: () => [item],
  };
}

/** Inject context computed lazily at run time from the {@link EngineContext}. */
export function dynamicContext(
  name: string,
  fn: (
    ctx: EngineContext,
    run?: ContextResolveContext,
  ) => unknown | Promise<unknown>,
  title?: string,
): ContextProvider {
  return {
    name,
    resolve: async (ctx, run) => {
      const content = await fn(ctx, run);
      return [{ content, ...(title !== undefined ? { title } : {}) }];
    },
  };
}

/**
 * Resolve all providers and fold their items into a single `system` message
 * (the injected-context block), or `[]` when there is nothing to inject.
 * Providers resolve concurrently; their declaration order is preserved in the
 * output.
 */
export async function resolveContext(
  providers: readonly ContextProvider[] | undefined,
  ctx: EngineContext,
  run?: ContextResolveContext,
): Promise<Message[]> {
  if (providers === undefined || providers.length === 0) return [];
  const resolved = await Promise.all(providers.map((p) => p.resolve(ctx, run)));
  const blocks = resolved
    .flat()
    .map(renderItem)
    .filter((s) => s !== "");
  if (blocks.length === 0) return [];
  return [system(blocks.join("\n\n"))];
}
