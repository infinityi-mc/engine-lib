import { describe, expect, it } from "bun:test";

import { boot } from "@infinityi/forge/lifecycle";
import type { BootOptions } from "@infinityi/forge/lifecycle";
import { agentRuntimeComponent } from "../src/lifecycle/index";
import type { ProviderProbe } from "../src/lifecycle/index";
import { InMemorySessionStore } from "../src/session/index";
import { mockProvider } from "../src/testing/index";

/** A minimal lifecycle context for driving hooks directly. */
const ctx = {
  signal: new AbortController().signal,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

/** Boot options that never touch real process signals or `process.exit`. */
const bootOpts = (components: BootOptions["components"]): BootOptions => ({
  components,
  installSignals: false,
  exit: () => {},
});

describe("agentRuntimeComponent — config validation on start", () => {
  it("defaults the component name and starts with no providers", async () => {
    const component = agentRuntimeComponent({});
    expect(component.name).toBe("agent-runtime");
    await expect(component.start?.(ctx)).resolves.toBeUndefined();
  });

  it("honors a custom name", () => {
    expect(agentRuntimeComponent({ name: "llm" }).name).toBe("llm");
  });

  it("rejects duplicate provider names", async () => {
    const component = agentRuntimeComponent({
      providers: [
        mockProvider({ name: "openai" }),
        mockProvider({ name: "openai" }),
      ],
    });
    await expect(component.start?.(ctx)).rejects.toThrow(
      /duplicate provider name/,
    );
  });

  it("rejects a provider with an empty defaultModel", async () => {
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "p", defaultModel: "" })],
    });
    await expect(component.start?.(ctx)).rejects.toThrow(/empty defaultModel/);
  });

  it("fails start when a probe rejects and probeOnStart is set", async () => {
    const probe: ProviderProbe = () => Promise.reject(new Error("unreachable"));
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "p" })],
      probe,
      probeOnStart: true,
    });
    await expect(component.start?.(ctx)).rejects.toThrow(
      /probe failed on start/,
    );
  });

  it("does not probe on start unless probeOnStart is set", async () => {
    let probed = false;
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "p" })],
      probe: () => {
        probed = true;
      },
    });
    await component.start?.(ctx);
    expect(probed).toBe(false);
  });
});

describe("agentRuntimeComponent — healthcheck", () => {
  it("is healthy with no probe configured", async () => {
    const result = await agentRuntimeComponent({
      providers: [mockProvider()],
    }).healthcheck?.(ctx);
    expect(result?.status).toBe("healthy");
    expect(result?.data?.["providers"]).toBe(1);
  });

  it("is healthy when every probe passes", async () => {
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "a" }), mockProvider({ name: "b" })],
      probe: () => Promise.resolve(),
    });
    expect((await component.healthcheck?.(ctx))?.status).toBe("healthy");
  });

  it("is degraded when some providers fail", async () => {
    const probe: ProviderProbe = (p) =>
      p.name === "b" ? Promise.reject(new Error("down")) : Promise.resolve();
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "a" }), mockProvider({ name: "b" })],
      probe,
    });
    const result = await component.healthcheck?.(ctx);
    expect(result?.status).toBe("degraded");
    expect(result?.detail).toContain("b");
    expect(result?.data?.["unhealthy"]).toBe(1);
  });

  it("is unhealthy when all providers fail", async () => {
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "a" })],
      probe: () => Promise.reject(new Error("down")),
    });
    expect((await component.healthcheck?.(ctx))?.status).toBe("unhealthy");
  });
});

describe("agentRuntimeComponent — stop", () => {
  it("runs the onStop hook", async () => {
    let closed = false;
    const component = agentRuntimeComponent({
      sessionStore: new InMemorySessionStore(),
      onStop: () => {
        closed = true;
      },
    });
    await component.stop?.(ctx);
    expect(closed).toBe(true);
  });
});

describe("agentRuntimeComponent — inside forge.boot", () => {
  it("boots to ready and drains cleanly, running onStop", async () => {
    let stopped = false;
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "openai" })],
      sessionStore: new InMemorySessionStore(),
      probe: () => Promise.resolve(),
      probeOnStart: true,
      onStop: () => {
        stopped = true;
      },
    });

    const app = await boot(bootOpts([component]));
    expect(app.ready).toBe(true);
    expect(app.components.map((c) => c.name)).toContain("agent-runtime");

    await app.stop("test");
    await app.done;
    expect(stopped).toBe(true);
  });

  it("rolls back boot when start fails (duplicate provider names)", async () => {
    const component = agentRuntimeComponent({
      providers: [mockProvider({ name: "dup" }), mockProvider({ name: "dup" })],
    });
    await expect(boot(bootOpts([component]))).rejects.toThrow();
  });
});
