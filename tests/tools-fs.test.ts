import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FilesystemPolicyError } from "../src/errors";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/tools/types";
import { filesystemTools } from "../src/tools-fs/index";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "engine-lib-fs-")));
  roots.push(root);
  return root;
}

function ctx(): ToolContext {
  return { toolCallId: "call-1", agentName: "test" };
}

async function run(tool: ToolDefinition, args: unknown): Promise<ToolResult> {
  return tool.execute(args as never, ctx());
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("filesystemTools config", () => {
  it("throws on missing or relative allowed roots", () => {
    expect(() => filesystemTools({ allowedRoots: [] })).toThrow(
      FilesystemPolicyError,
    );
    expect(() => filesystemTools({ allowedRoots: ["relative"] })).toThrow(
      FilesystemPolicyError,
    );
  });

  it("exposes every fs.json tool", async () => {
    const root = await workspace();
    const tools = filesystemTools({ allowedRoots: [root] });
    expect(
      Object.values(tools)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "apply_patch",
      "diff_status",
      "edit_range",
      "edit_replace",
      "find_files",
      "open_window",
      "read",
      "repo_map",
      "search_semantic",
      "search_text",
      "symbols",
      "write_file",
    ]);
  });
});

describe("filesystemTools read/search/discovery", () => {
  it("maps a workspace, finds files, searches text, reads ranges, and extracts symbols", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","dependencies":{"vite":"latest"}}',
    );
    await writeFile(
      join(root, "index.ts"),
      [
        "import fs from 'node:fs';",
        "export function greet(name: string) {",
        "  return `hello ${name}`;",
        "}",
        "const hidden = 1;",
      ].join("\n"),
    );
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "needle");

    const tools = filesystemTools({ allowedRoots: [root] });
    const map = await run(tools.repoMap, { include_symbols: true });
    expect(map.ok).toBe(true);
    expect(JSON.stringify((map as { content: unknown }).content)).toContain(
      "index.ts",
    );
    expect(JSON.stringify((map as { content: unknown }).content)).toContain(
      "TypeScript",
    );

    const found = await run(tools.findFiles, { query: "index", mode: "fuzzy" });
    expect(found.ok).toBe(true);
    expect(JSON.stringify((found as { content: unknown }).content)).toContain(
      "index.ts",
    );

    const text = await run(tools.searchText, {
      pattern: "hello",
      mode: "literal",
    });
    expect(text.ok).toBe(true);
    expect(JSON.stringify((text as { content: unknown }).content)).toContain(
      "index.ts",
    );
    expect(
      JSON.stringify((text as { content: unknown }).content),
    ).not.toContain("ignored.txt");

    const semantic = await run(tools.searchSemantic, {
      query: "greet hello",
      granularity: "symbol",
    });
    expect(semantic.ok).toBe(true);
    expect(
      JSON.stringify((semantic as { content: unknown }).content),
    ).toContain("greet");

    const regexText = await run(tools.searchText, {
      pattern: "hello|greet",
      mode: "regex",
    });
    expect(regexText.ok).toBe(true);
    expect(JSON.stringify((regexText as { content: unknown }).content)).toContain(
      "index.ts",
    );

    const symbols = await run(tools.symbols, { path: "index.ts" });
    expect(symbols.ok).toBe(true);
    expect(JSON.stringify((symbols as { content: unknown }).content)).toContain(
      "greet",
    );

    const read = await run(tools.read, { path: "index.ts", symbol: "greet" });
    expect(read.ok).toBe(true);
    expect(JSON.stringify((read as { content: unknown }).content)).toContain(
      "export function greet",
    );
  });

  it("rejects unsafe regex patterns before filesystem searches", async () => {
    const root = await workspace();
    await writeFile(join(root, "index.ts"), "aaaaaaaaaaaaaaaaaaaa!");
    const tools = filesystemTools({ allowedRoots: [root] });

    const unsafeText = await run(tools.searchText, {
      pattern: "(a+)+$",
      mode: "regex",
    });
    expect(unsafeText.ok).toBe(false);
    expect((unsafeText as { error: string }).error).toContain(
      "catastrophic backtracking",
    );

    const longText = await run(tools.searchText, {
      pattern: "a".repeat(257),
      mode: "regex",
    });
    expect(longText.ok).toBe(false);
    expect((longText as { error: string }).error).toContain("maximum length");

    const unsafeFind = await run(tools.findFiles, {
      query: "(a+)+$",
      mode: "regex",
    });
    expect(unsafeFind.ok).toBe(false);
    expect((unsafeFind as { error: string }).error).toContain(
      "catastrophic backtracking",
    );
  });

  it("rejects paths outside the configured root", async () => {
    const root = await workspace();
    const tools = filesystemTools({ allowedRoots: [root] });
    const res = await run(tools.read, { path: ".." });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain(
      "outside the allowed roots",
    );
  });

  it("rejects symlinks that resolve outside the configured root when the platform allows creating them", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.txt"), "secret");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return;
    }

    const tools = filesystemTools({ allowedRoots: [root] });
    const res = await run(tools.read, { path: "link.txt" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("resolves outside");
  });
});

describe("filesystemTools edits and diff", () => {
  it("writes, appends, replaces, edits ranges, applies patches, and reports versions", async () => {
    const root = await workspace();
    const tools = filesystemTools({ allowedRoots: [root] });

    const created = await run(tools.writeFile, {
      path: "note.txt",
      content: "one\ntwo\n",
    });
    expect(created.ok).toBe(true);
    const version = (created as { content: { fileVersion: string } }).content
      .fileVersion;

    const mismatch = await run(tools.editReplace, {
      path: "note.txt",
      old_text: "two",
      new_text: "TWO",
      expected_file_version: "sha256:nope",
    });
    expect(mismatch.ok).toBe(false);

    const replaced = await run(tools.editReplace, {
      path: "note.txt",
      old_text: "two",
      new_text: "TWO",
      expected_file_version: version,
    });
    expect(replaced.ok).toBe(true);
    const replacedVersion = (replaced as { content: { fileVersion: string } })
      .content.fileVersion;

    const ranged = await run(tools.editRange, {
      path: "note.txt",
      start_line: 1,
      end_line: 1,
      new_text: "ONE",
      expected_file_version: replacedVersion,
    });
    expect(ranged.ok).toBe(true);
    expect(await readFile(join(root, "note.txt"), "utf8")).toContain(
      "ONE\nTWO",
    );

    const appended = await run(tools.writeFile, {
      path: "note.txt",
      content: "three",
      mode: "append",
    });
    expect(appended.ok).toBe(true);

    const patch = [
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1,3 +1,3 @@",
      " ONE",
      " TWO",
      "-three",
      "+THREE",
      "",
    ].join("\n");
    const patched = await run(tools.applyPatch, { patch });
    expect(patched.ok).toBe(true);
    expect(await readFile(join(root, "note.txt"), "utf8")).toContain("THREE");
  });

  it("returns git status and diffs for a temporary repository when git is available", async () => {
    const root = await workspace();
    try {
      await execFileAsync("git", ["init"], { cwd: root, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
        windowsHide: true,
      });
      await execFileAsync("git", ["config", "user.name", "Test User"], {
        cwd: root,
        windowsHide: true,
      });
    } catch {
      return;
    }
    await writeFile(join(root, "a.txt"), "one\n");
    await writeFile(join(root, "b.txt"), "two\n");
    await execFileAsync("git", ["add", "a.txt", "b.txt"], {
      cwd: root,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: root,
      windowsHide: true,
    });
    await writeFile(join(root, "a.txt"), "ONE\n");
    await writeFile(join(root, "b.txt"), "TWO\n");

    const tools = filesystemTools({ allowedRoots: [root] });
    const status = await run(tools.diffStatus, {});
    expect(status.ok).toBe(true);
    const files = (
      status as { content: { files: Array<{ path: string; diff: string }> } }
    ).content.files;
    const a = files.find((file) => file.path === "a.txt");
    const b = files.find((file) => file.path === "b.txt");
    expect(a?.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(a?.diff).not.toContain("diff --git a/b.txt b/b.txt");
    expect(b?.diff).toContain("diff --git a/b.txt b/b.txt");
    expect(b?.diff).not.toContain("diff --git a/a.txt b/a.txt");
  });

  it("reports non-git roots without failing", async () => {
    const root = await workspace();
    const tools = filesystemTools({ allowedRoots: [root] });
    const status = await run(tools.diffStatus, {});
    expect(status.ok).toBe(true);
    expect(
      (status as { content: { isGitRepo: boolean } }).content.isGitRepo,
    ).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});
