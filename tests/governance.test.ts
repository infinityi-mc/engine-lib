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
});
