import { describe, expect, it } from "bun:test";

import { resolveSecret, Secret } from "../src/runtime/index";

describe("resolveSecret", () => {
  it("unwraps a forge Secret", () => {
    expect(resolveSecret(new Secret("sk-123"))).toBe("sk-123");
  });

  it("passes a raw string through", () => {
    expect(resolveSecret("sk-456")).toBe("sk-456");
  });
});
