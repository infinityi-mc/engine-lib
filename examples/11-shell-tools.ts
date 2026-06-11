import type { ToolContext, ToolDefinition, ToolResult } from "@infinityi/engine-lib/tools";
import { shellTools } from "@infinityi/engine-lib/tools-shell";

const cwd = process.cwd();
const shell = shellTools({
  allowedCwds: [cwd],
  policy: {
    allow: [process.execPath],
    deny: [/\brm\b/, /\bsudo\b/],
  },
  env: { allow: ["PATH"] },
  requiresApproval: (request) => request.command !== process.execPath,
  approve: () => ({ approved: false, reason: "example denies unrecognized commands" }),
});

const result = await runTool(shell.runCommand, {
  command: process.execPath,
  args: ["-e", "console.log('hello from shell tool')"],
  cwd,
  timeoutMs: 5_000,
});

console.log(content(result));

async function runTool<TArgs>(
  tool: ToolDefinition<TArgs>,
  args: TArgs,
): Promise<ToolResult> {
  const ctx: ToolContext = { toolCallId: "example-shell", agentName: "example" };
  return tool.execute(args, ctx);
}

function content(result: ToolResult): unknown {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.content;
}

