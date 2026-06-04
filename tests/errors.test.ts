import { describe, expect, it } from "bun:test";

import {
  AgentError,
  CancelledError,
  ProviderError,
  SchemaValidationError,
  ToolError,
  ToolValidationError,
} from "../src/errors";

describe("error taxonomy", () => {
  it("roots every error at AgentError", () => {
    expect(new ProviderError("x")).toBeInstanceOf(AgentError);
    expect(new ToolError("x")).toBeInstanceOf(AgentError);
    expect(new CancelledError("x")).toBeInstanceOf(AgentError);
  });

  it("chains ToolValidationError → SchemaValidationError → AgentError", () => {
    const err = new ToolValidationError("bad args", {
      toolName: "read_file",
      issues: [{ path: ["path"], message: "required" }],
    });
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.toolName).toBe("read_file");
    expect(err.issues).toHaveLength(1);
  });

  it("sets a stable name and preserves cause + typed fields", () => {
    const cause = new Error("root");
    const err = new ProviderError("upstream failed", { provider: "openai", cause });
    expect(err.name).toBe("ProviderError");
    expect(err.provider).toBe("openai");
    expect(err.cause).toBe(cause);
  });
});
