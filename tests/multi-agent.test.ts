import { describe, expect, it } from "bun:test";

import { ExecutionError } from "../src/errors";
import { createAgentRegistry, defineAgent } from "../src/agent/index";
import { mockProvider } from "../src/testing/index";

const provider = mockProvider({ name: "mock", defaultModel: "mock-model" });

const triage = defineAgent({ name: "triage", provider, instructions: "route" });
const billing = defineAgent({ name: "billing", provider, instructions: "billing" });
const support = defineAgent({ name: "support", provider, instructions: "support" });

describe("createAgentRegistry", () => {
  it("seeds, looks up, and lists agents in registration order", () => {
    const registry = createAgentRegistry([triage, billing]);

    expect(registry.size).toBe(2);
    expect(registry.has("triage")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("billing")).toBe(billing);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().map((a) => a.name)).toEqual(["triage", "billing"]);
  });

  it("starts empty when no agents are provided", () => {
    const registry = createAgentRegistry();
    expect(registry.size).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("registers additional agents after construction", () => {
    const registry = createAgentRegistry([triage]);
    registry.register(support);

    expect(registry.size).toBe(2);
    expect(registry.resolve("support")).toBe(support);
    expect(registry.list().map((a) => a.name)).toEqual(["triage", "support"]);
  });

  it("returns a stable snapshot from list() that a later register() cannot mutate", () => {
    const registry = createAgentRegistry([triage]);
    const snapshot = registry.list();
    expect(snapshot).toHaveLength(1);

    registry.register(billing);
    expect(snapshot).toHaveLength(1);
    expect(registry.list()).toHaveLength(2);
  });

  it("resolve() returns the agent or throws a clear ExecutionError", () => {
    const registry = createAgentRegistry([triage]);
    expect(registry.resolve("triage")).toBe(triage);
    expect(() => registry.resolve("nope")).toThrow(ExecutionError);
    expect(() => registry.resolve("nope")).toThrow('unknown agent: "nope"');
  });

  it("fails fast on a duplicate name when seeding", () => {
    const dupe = defineAgent({ name: "triage", provider });
    expect(() => createAgentRegistry([triage, dupe])).toThrow(ExecutionError);
    expect(() => createAgentRegistry([triage, dupe])).toThrow(
      'duplicate agent name: "triage"',
    );
  });

  it("fails fast on a duplicate name when registering", () => {
    const registry = createAgentRegistry([triage]);
    const dupe = defineAgent({ name: "triage", provider });
    expect(() => registry.register(dupe)).toThrow(ExecutionError);
  });
});
