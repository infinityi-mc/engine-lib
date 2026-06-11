import { agentRuntimeComponent } from "@infinityi/engine-lib/lifecycle";
import { mockProvider } from "@infinityi/engine-lib/testing";

const provider = mockProvider({ name: "mock-provider", defaultModel: "mock-model" });
const component = agentRuntimeComponent({
  providers: [provider],
  probeOnStart: true,
  probe: async (candidate) => {
    await candidate.complete({ messages: [] });
  },
  onStop: () => {
    console.log("runtime stopped");
  },
});

const signal = new AbortController().signal;
const logger = {
  trace: console.debug,
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

if (component.start !== undefined) {
  await component.start({ signal, logger } as Parameters<typeof component.start>[0]);
}

if (component.healthcheck !== undefined) {
  const health = await component.healthcheck({ signal, logger } as Parameters<typeof component.healthcheck>[0]);
  console.log(health);
}

if (component.stop !== undefined) {
  await component.stop({ signal, logger } as Parameters<typeof component.stop>[0]);
}

