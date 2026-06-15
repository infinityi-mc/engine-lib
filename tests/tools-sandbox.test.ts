import { describe, expect, it } from "bun:test";

import { SandboxError } from "../src/errors";
import type { ToolContext } from "../src/tools/types";
import type { CommandResult } from "../src/tools-shell/types";
import { buildRunArgs } from "../src/tools-sandbox/docker";
import { shellTools } from "../src/tools-shell/index";
import { dockerSandbox, localSandbox } from "../src/tools-sandbox/index";
import type { SandboxOptions } from "../src/tools-sandbox/index";

const ROOT = process.cwd();
const JS = process.execPath;

function ctx(): ToolContext {
  return { toolCallId: "c1", agentName: "test" };
}

function baseOptions(over: Partial<SandboxOptions> = {}): SandboxOptions {
  return {
    cwd: ROOT,
    env: {},
    timeoutMs: 10_000,
    networkAccess: true,
    filesystemPaths: [ROOT],
    maxOutputBytes: 100_000,
    ...over,
  };
}

describe("SANDBOX-T1 localSandbox", () => {
  it("reproduces direct execCommand behaviour (AC-11/13)", async () => {
    const sandbox = localSandbox();
    const result = await sandbox.execute(
      JS,
      ["-e", "console.log('hello'); process.exit(0)"],
      baseOptions(),
    );
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("streams chunks like spawn_command", async () => {
    const chunks: string[] = [];
    const sandbox = localSandbox();
    await sandbox.execute(
      JS,
      ["-e", "console.log('streamed')"],
      baseOptions({ onChunk: (c) => chunks.push(c.text) }),
    );
    expect(chunks.join("")).toContain("streamed");
  });

  it("fails closed when asked for networkAccess:false without downgrade (AC-14)", async () => {
    const sandbox = localSandbox();
    await expect(
      sandbox.execute(JS, ["-e", "0"], baseOptions({ networkAccess: false })),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("runs unisolated when the downgrade is explicitly allowed (FR-24)", async () => {
    const sandbox = localSandbox({ allowNetworkDowngrade: true });
    const result = await sandbox.execute(
      JS,
      ["-e", "console.log('ok')"],
      baseOptions({ networkAccess: false }),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("SANDBOX-T1 shell integration", () => {
  it("shellTools with localSandbox matches the default no-sandbox path (AC-11)", async () => {
    const direct = shellTools({ allowedCwds: [ROOT] });
    const sandboxed = shellTools({
      allowedCwds: [ROOT],
      sandbox: localSandbox(),
    });
    const args = { command: JS, args: ["-e", "console.log('parity')"] };

    const a = await direct.runCommand.execute(args as never, ctx());
    const b = await sandboxed.runCommand.execute(args as never, ctx());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const ra = (a as { content: CommandResult }).content;
    const rb = (b as { content: CommandResult }).content;
    expect(rb.stdout.trim()).toBe(ra.stdout.trim());
    expect(rb.exitCode).toBe(ra.exitCode);
  });

  it("a fail-closed sandbox surfaces as a ToolFailure, not a throw", async () => {
    const { runCommand } = shellTools({
      allowedCwds: [ROOT],
      sandbox: localSandbox(),
      networkAccess: false,
    });
    const res = await runCommand.execute(
      { command: JS, args: ["-e", "0"] } as never,
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("networkAccess");
  });
});

// --- dockerSandbox: gated on a container runtime being present ---------------

async function hasDocker(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["docker", "version"],
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

describe("SANDBOX-T1 dockerSandbox", () => {
  it("uses the first mounted filesystem path as the container workdir", () => {
    const unmountedCwd = `${ROOT}-unmounted`;
    const args = buildRunArgs(
      "alpine:3",
      "pwd",
      [],
      baseOptions({ cwd: unmountedCwd, filesystemPaths: [ROOT] }),
      [],
    );

    const workdirFlag = args.indexOf("-w");
    expect(workdirFlag).toBeGreaterThanOrEqual(0);
    expect(args[workdirFlag + 1]).toBe(ROOT);
  });

  it("falls back to the requested cwd when there are no mounted paths", () => {
    const args = buildRunArgs(
      "alpine:3",
      "pwd",
      [],
      baseOptions({ filesystemPaths: [] }),
      [],
    );

    const workdirFlag = args.indexOf("-w");
    expect(workdirFlag).toBeGreaterThanOrEqual(0);
    expect(args[workdirFlag + 1]).toBe(ROOT);
  });

  it("isolates the network with networkAccess:false (AC-12)", async () => {
    if (!(await hasDocker())) {
      // No container runtime available in this environment; skip the live check.
      expect(true).toBe(true);
      return;
    }
    const sandbox = dockerSandbox({ image: "alpine:3" });
    // A local-only command succeeds.
    const ok = await sandbox.execute(
      "echo",
      ["hi"],
      baseOptions({ networkAccess: false }),
    );
    expect(ok.stdout.trim()).toBe("hi");
    // A network call fails (no reachability) — wget/ping should be unable to resolve.
    const blocked = await sandbox.execute(
      "sh",
      ["-c", "wget -T 2 -q -O- http://example.com || echo NETFAIL"],
      baseOptions({ networkAccess: false }),
    );
    expect(blocked.stdout).toContain("NETFAIL");
  }, 60_000);
});
