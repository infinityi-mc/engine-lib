import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { RunBridgeEvent } from "../src/execution/types";
import { ShellPolicyError } from "../src/errors";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/tools/types";
import {
  classifyCommand,
  filterEnv,
  resolveCwd,
} from "../src/tools-shell/policy";
import { shellTools } from "../src/tools-shell/index";
import type { CommandResult } from "../src/tools-shell/types";

// --- helpers ---------------------------------------------------------------

/** A ToolContext whose run bridge captures every emitted event. */
function captureCtx(): { ctx: ToolContext; events: RunBridgeEvent[] } {
  const events: RunBridgeEvent[] = [];
  const ctx: ToolContext = {
    toolCallId: "call-1",
    agentName: "test",
    run: {
      emit: (event) => events.push(event),
      reportUsage: () => {},
    },
  };
  return { ctx, events };
}

/** Names of `custom` events emitted, in order. */
function customNames(events: RunBridgeEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<RunBridgeEvent, { type: "custom" }> =>
        e.type === "custom",
    )
    .map((e) => e.name);
}

async function run(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  return tool.execute(args as never, ctx);
}

const ROOT = process.cwd();
const JS = process.execPath;

// --- pure policy units -----------------------------------------------------

describe("resolveCwd", () => {
  it("accepts the root itself and descendants", () => {
    expect(resolveCwd(undefined, [ROOT])).toBe(ROOT);
    expect(resolveCwd("src", [ROOT])).toBe(join(ROOT, "src"));
  });
  it("rejects paths that escape every root", () => {
    expect(resolveCwd("..", [ROOT])).toBeNull();
    expect(resolveCwd("/etc", [ROOT])).toBeNull();
  });
});

describe("classifyCommand", () => {
  it("allows everything with no policy", () => {
    expect(classifyCommand("rm", ["-rf", "/"], undefined).allowed).toBe(true);
  });
  it("deny wins over allow", () => {
    const policy = { allow: ["rm"], deny: [/\brm\b/] };
    expect(classifyCommand("rm", ["-rf"], policy).allowed).toBe(false);
  });
  it("requires an allow match when allow is present", () => {
    const policy = { allow: ["echo"] };
    expect(classifyCommand("echo", [], policy).allowed).toBe(true);
    expect(classifyCommand("ls", [], policy).allowed).toBe(false);
  });
  it("stays denied across repeated calls with a global-flag regex", () => {
    // `g`/`y` regexes advance lastIndex; a reused deny rule must not alternate.
    const policy = { deny: [/\brm\b/g] };
    expect(classifyCommand("rm", ["-rf"], policy).allowed).toBe(false);
    expect(classifyCommand("rm", ["-rf"], policy).allowed).toBe(false);
    expect(classifyCommand("rm", ["-rf"], policy).allowed).toBe(false);
  });
});

describe("filterEnv", () => {
  const env = { PATH: "/bin", SECRET: "x", HOME: "/home/u" };
  it("passes no inherited vars by default", () => {
    expect(filterEnv(env, undefined)).toEqual({});
  });
  it("passes only allowed vars, applies deny and extra", () => {
    const out = filterEnv(env, {
      allow: ["PATH", "SECRET"],
      deny: ["SECRET"],
      extra: { FOO: "1" },
    });
    expect(out).toEqual({ PATH: "/bin", FOO: "1" });
  });
});

// --- factory validation ----------------------------------------------------

describe("shellTools config validation", () => {
  it("throws on empty allowedCwds", () => {
    expect(() => shellTools({ allowedCwds: [] })).toThrow(ShellPolicyError);
  });
  it("throws on a non-absolute allowedCwds entry", () => {
    expect(() => shellTools({ allowedCwds: ["./relative"] })).toThrow(
      ShellPolicyError,
    );
  });
  it("exposes run_command and spawn_command", () => {
    const { runCommand, spawnCommand } = shellTools({ allowedCwds: [ROOT] });
    expect(runCommand.name).toBe("run_command");
    expect(spawnCommand.name).toBe("spawn_command");
  });
});

// --- run_command behavior --------------------------------------------------

describe("run_command", () => {
  it("captures stdout and a zero exit code", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx, events } = captureCtx();
    const res = await run(
      runCommand,
      { command: JS, args: ["-e", "console.log('hello')"] },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { content: CommandResult }).content;
    expect(out.stdout.trim()).toBe("hello");
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
    expect(customNames(events)).toEqual([
      "shell.policy",
      "shell.exec.start",
      "shell.exec.end",
    ]);
  });

  it("returns ok:true with a non-zero exit code (model sees failures)", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx } = captureCtx();
    const res = await run(
      runCommand,
      { command: JS, args: ["-e", "process.exit(3)"] },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res as { content: CommandResult }).content.exitCode).toBe(3);
  });

  it("denies a cwd outside the allowlist without spawning", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx, events } = captureCtx();
    const res = await run(
      runCommand,
      { command: "echo", args: ["x"], cwd: "/etc" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(customNames(events)).toEqual(["shell.policy"]);
    const policy = events.find((e) => e.type === "custom") as Extract<
      RunBridgeEvent,
      { type: "custom" }
    >;
    expect(policy.data.decision).toBe("deny");
  });

  it("denies a command blocked by policy", async () => {
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      policy: { deny: [/\brm\b/] },
    });
    const { ctx } = captureCtx();
    const res = await run(
      runCommand,
      { command: "rm", args: ["-rf", "/tmp/x"] },
      ctx,
    );
    expect(res.ok).toBe(false);
  });

  it("times out a long-running command", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx } = captureCtx();
    const res = await run(
      runCommand,
      {
        command: JS,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 100,
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { content: CommandResult }).content;
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
  });

  it("truncates output beyond the byte cap", async () => {
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      maxOutputBytes: 64,
    });
    const { ctx } = captureCtx();
    const res = await run(
      runCommand,
      {
        command: JS,
        args: ["-e", "for (let i = 0; i < 1000; i++) console.log(`line${i}`)"],
      },
      ctx,
    );
    const out = (res as { content: CommandResult }).content;
    expect(out.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(64);
  });

  it("reports a spawn failure for an unknown program", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx, events } = captureCtx();
    const res = await run(
      runCommand,
      { command: "definitely-not-a-real-binary-xyz" },
      ctx,
    );
    expect(res.ok).toBe(false);
    // The exec lifecycle stays paired even on a spawn failure.
    expect(customNames(events)).toEqual([
      "shell.policy",
      "shell.exec.start",
      "shell.exec.end",
    ]);
    const end = events
      .filter(
        (e): e is Extract<RunBridgeEvent, { type: "custom" }> =>
          e.type === "custom",
      )
      .find((e) => e.name === "shell.exec.end");
    expect(end?.data.error).toBeDefined();
    expect(end?.data.exitCode).toBeNull();
  });
});

// --- approval --------------------------------------------------------------

describe("approval gating", () => {
  it("never executes when approval is required and denied", async () => {
    let approveCalled = false;
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      requiresApproval: (req) => req.command === JS,
      approve: () => {
        approveCalled = true;
        return false;
      },
    });
    const { ctx, events } = captureCtx();
    const res = await run(
      runCommand,
      { command: JS, args: ["-e", "console.log('nope')"] },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(approveCalled).toBe(true);
    expect(customNames(events)).toEqual([
      "shell.policy",
      "shell.approval",
      "shell.approval",
    ]);
    // No exec.start means the process never ran.
    expect(customNames(events)).not.toContain("shell.exec.start");
  });

  it("executes after approval is granted", async () => {
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      requiresApproval: () => true,
      approve: () => ({ approved: true, reason: "ok" }),
    });
    const { ctx, events } = captureCtx();
    const res = await run(
      runCommand,
      { command: JS, args: ["-e", "console.log('go')"] },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(customNames(events)).toEqual([
      "shell.policy",
      "shell.approval",
      "shell.approval",
      "shell.exec.start",
      "shell.exec.end",
    ]);
  });

  it("denies by default when requiresApproval is true but no approve hook is set", async () => {
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      requiresApproval: () => true,
    });
    const { ctx } = captureCtx();
    const res = await run(runCommand, { command: "echo", args: ["x"] }, ctx);
    expect(res.ok).toBe(false);
  });
});

// --- spawn_command streaming -----------------------------------------------

describe("spawn_command", () => {
  it("streams output as shell.exec.chunk events", async () => {
    const { spawnCommand } = shellTools({ allowedCwds: [ROOT] });
    const { ctx, events } = captureCtx();
    const res = await run(
      spawnCommand,
      { command: JS, args: ["-e", "console.log('streamed ✓ café')"] },
      ctx,
    );
    expect(res.ok).toBe(true);
    const chunks = events
      .filter(
        (e): e is Extract<RunBridgeEvent, { type: "custom" }> =>
          e.type === "custom",
      )
      .filter((e) => e.name === "shell.exec.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.map((c) => c.data.text as string).join("");
    // Multi-byte characters survive the streaming decoder intact.
    expect(joined).toContain("streamed ✓ café");
  });
});

// --- runs without a run bridge ---------------------------------------------

describe("tool invoked outside a run", () => {
  it("works with no ctx.run (emits are no-ops)", async () => {
    const { runCommand } = shellTools({ allowedCwds: [ROOT] });
    const ctx: ToolContext = { toolCallId: "x" };
    const res = await run(
      runCommand,
      { command: JS, args: ["-e", "console.log('ok')"] },
      ctx,
    );
    expect(res.ok).toBe(true);
  });
});
