import { describe, expect, it } from "bun:test";

import { composePolicies } from "../src/governance/index";

describe("composePolicies", () => {
  it("passes recomputed targets after in-place argument transforms", async () => {
    const args = { url: "https://old.example/" };
    const seenTargets: string[] = [];
    const policy = composePolicies(
      {
        evaluate: (action) => {
          (action.arguments as { url: string }).url = "https://new.example/";
          return { allowed: true, transformArguments: action.arguments };
        },
      },
      {
        evaluate: (action) => {
          seenTargets.push(action.target);
          return { allowed: true };
        },
      },
    );

    await policy.evaluate(
      {
        tool: "http_get",
        operation: "network",
        target: args.url,
        arguments: args,
      },
      { agentName: "a", messages: [] },
    );

    expect(seenTargets).toEqual(["https://new.example/"]);
  });

  it("uses explicit transformTarget when transformed arguments rename target key", async () => {
    const seenTargets: string[] = [];
    const policy = composePolicies(
      {
        evaluate: () => ({
          allowed: true,
          transformArguments: { endpoint: "https://new.example/" },
          transformTarget: "https://new.example/",
        }),
      },
      {
        evaluate: (action) => {
          seenTargets.push(action.target);
          return { allowed: true };
        },
      },
    );

    const decision = await policy.evaluate(
      {
        tool: "http_get",
        operation: "network",
        target: "https://old.example/",
        arguments: { url: "https://old.example/" },
      },
      { agentName: "a", messages: [] },
    );

    expect(seenTargets).toEqual(["https://new.example/"]);
    expect(decision).toMatchObject({
      allowed: true,
      transformTarget: "https://new.example/",
    });
  });
});
