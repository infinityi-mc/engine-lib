import { describe, expect, it } from "bun:test";

import { ExecutionError } from "../src/errors";
import {
  createToolRegistry,
  defineAgent,
  defineTool,
} from "../src/agent/index";
import type { AgentHooks, Instructions } from "../src/agent/index";
import { s } from "../src/schema/index";
import { mockProvider } from "../src/testing/index";

const provider = mockProvider({ name: "mock", defaultModel: "mock-model" });

const echo = defineTool({
  name: "echo",
  parameters: s.object({ value: s.string() }),
  execute: ({ value }) => ({ ok: true, content: value }),
});
const ping = defineTool({
  name: "ping",
  parameters: s.object({}),
  execute: () => ({ ok: true, content: "pong" }),
});

describe("defineAgent", () => {
  it("returns the definition as data", () => {
    const agent = defineAgent({
      name: "coder",
      provider,
      instructions: "You are a coding assistant.",
      tools: [echo, ping],
      generation: { temperature: 0.2, toolChoice: "auto" },
    });

    expect(agent.name).toBe("coder");
    expect(agent.provider).toBe(provider);
    expect(agent.tools).toHaveLength(2);
    expect(agent.generation?.temperature).toBe(0.2);
  });

  it("supports static and dynamic instructions", async () => {
    const staticInstr: Instructions = "be terse";
    const dynamicInstr: Instructions = (c) => `agent is ${c.agent.name}`;

    const agent = defineAgent({
      name: "dyn",
      provider,
      instructions: dynamicInstr,
    });
    expect(staticInstr).toBe("be terse");
    expect(typeof agent.instructions).toBe("function");
    if (typeof agent.instructions === "function") {
      expect(await agent.instructions({ agent })).toBe("agent is dyn");
    }
  });

  it("accepts typed lifecycle hook slots", () => {
    const hooks: AgentHooks = {
      onStart: () => {},
      onToolResult: ({ result }) => {
        if (!result.ok) throw new Error(result.error);
      },
    };
    const agent = defineAgent({ name: "hooked", provider, hooks });
    expect(agent.hooks?.onStart).toBeDefined();
  });

  it("rejects an empty name", () => {
    expect(() => defineAgent({ name: "  ", provider })).toThrow(TypeError);
  });

  it("throws on duplicate tool names at definition time", () => {
    const dup = defineTool({
      name: "echo",
      parameters: s.object({}),
      execute: () => ({ ok: true, content: "" }),
    });
    expect(() =>
      defineAgent({ name: "bad", provider, tools: [echo, dup] }),
    ).toThrow(ExecutionError);
  });
});

describe("createToolRegistry", () => {
  it("provides has/get/list lookup", () => {
    const reg = createToolRegistry([echo, ping]);
    expect(reg.size).toBe(2);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("missing")).toBe(false);
    expect(reg.get("ping")).toBe(ping);
    expect(reg.list().map((t) => t.name)).toEqual(["echo", "ping"]);
  });

  it("generates a provider toolset preserving order", () => {
    const reg = createToolRegistry([echo, ping]);
    expect(reg.toProviderTools().map((t) => t.name)).toEqual(["echo", "ping"]);
    expect(reg.toProviderTools()[0]?.parameters).toMatchObject({
      type: "object",
    });
  });

  it("throws ExecutionError on duplicate names", () => {
    expect(() => createToolRegistry([echo, echo])).toThrow(ExecutionError);
  });

  it("handles an empty toolset", () => {
    const reg = createToolRegistry([]);
    expect(reg.size).toBe(0);
    expect(reg.toProviderTools()).toEqual([]);
  });
});
