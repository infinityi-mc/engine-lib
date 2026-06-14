import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@infinityi/engine-lib/tools";
import { filesystemTools } from "@infinityi/engine-lib/tools-fs";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "engine-lib-example-fs-")),
);
const ctx: ToolContext = { toolCallId: "example-fs", agentName: "example" };

try {
  await writeFile(
    join(root, "service.ts"),
    ["export function status() {", "  return 'degraded';", "}"].join("\n"),
  );

  const fs = filesystemTools({ allowedRoots: [root] });

  const map = await runTool(fs.repoMap, { include_symbols: true });
  const search = await runTool(fs.searchText, {
    pattern: "degraded",
    mode: "literal",
  });
  const read = await runTool(fs.read, {
    path: "service.ts",
    include_line_numbers: true,
  });
  const diff = await runTool(fs.diffStatus, {});

  console.log({
    root,
    mapped: ok(map),
    searched: ok(search),
    read: ok(read),
    diff: ok(diff),
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runTool<TArgs>(
  tool: ToolDefinition<TArgs>,
  args: TArgs,
): Promise<ToolResult> {
  return tool.execute(args, ctx);
}

function ok(result: ToolResult): boolean {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return true;
}
