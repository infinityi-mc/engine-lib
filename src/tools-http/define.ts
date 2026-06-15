/**
 * Ready-made HTTP tool definitions.
 *
 * The factory is intentionally thin: host configuration is bound once, model
 * arguments are validated through JSON Schema, and every expected failure is
 * returned as a tool error.
 *
 * @module
 */

import { fromJsonSchema } from "../schema/json-schema";
import { defineTool } from "../tools/define";
import type { ToolContext, ToolResult } from "../tools/types";
import { createHttpToolClient } from "./client";
import type { HeaderEntry, HttpTools, HttpToolsConfig } from "./types";

interface HttpGetArgs {
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly timeout_ms?: number;
  readonly max_bytes?: number;
  readonly max_body_chars?: number;
}

interface HttpPostArgs extends HttpGetArgs {
  readonly body?: string;
  readonly body_json?: unknown;
  readonly content_type?: string;
}

const HEADER_SCHEMA = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      name: { type: "string" as const },
      value: { type: "string" as const },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const GET_PARAMS = fromJsonSchema<HttpGetArgs>({
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) URL to fetch." },
    headers: HEADER_SCHEMA,
    timeout_ms: {
      type: "integer",
      description: "Request timeout in milliseconds; clamped by host policy.",
    },
    max_bytes: {
      type: "integer",
      description: "Response byte cap; clamped by host policy.",
    },
    max_body_chars: {
      type: "integer",
      description: "Returned text character cap; clamped by host policy.",
    },
  },
  required: ["url"],
  additionalProperties: false,
});

const POST_PARAMS = fromJsonSchema<HttpPostArgs>({
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) URL to fetch." },
    headers: HEADER_SCHEMA,
    body: { type: "string", description: "Raw request body." },
    body_json: { description: "JSON value to serialize as the request body." },
    content_type: {
      type: "string",
      description: "Content-Type for body/body_json when not already set.",
    },
    timeout_ms: {
      type: "integer",
      description: "Request timeout in milliseconds; clamped by host policy.",
    },
    max_bytes: {
      type: "integer",
      description: "Response byte cap; clamped by host policy.",
    },
    max_body_chars: {
      type: "integer",
      description: "Returned text character cap; clamped by host policy.",
    },
  },
  required: ["url"],
  additionalProperties: false,
});

function fail(error: unknown): ToolResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

/** Build the `http_get` and `http_post` tools bound to host policy. */
export function httpTools(config: HttpToolsConfig): HttpTools {
  const client = createHttpToolClient(config);

  const httpGet = defineTool<HttpGetArgs>({
    name: "http_get",
    description:
      "Fetch one HTTP(S) URL under the host network policy and return compact parsed response metadata.",
    policy: { operation: "network", target: (args) => args.url },
    parameters: GET_PARAMS,
    async execute(args, ctx: ToolContext) {
      try {
        const content = await client.get(
          args.url,
          {
            headers: args.headers,
            timeoutMs: args.timeout_ms,
            maxBytes: args.max_bytes,
            maxBodyChars: args.max_body_chars,
          },
          ctx,
        );
        return { ok: true, content };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const httpPost = defineTool<HttpPostArgs>({
    name: "http_post",
    description:
      "POST to one HTTP(S) URL under the host network policy and return compact parsed response metadata.",
    policy: { operation: "network", target: (args) => args.url },
    parameters: POST_PARAMS,
    async execute(args, ctx: ToolContext) {
      try {
        const content = await client.post(
          args.url,
          {
            headers: args.headers,
            body: args.body,
            bodyJson: args.body_json,
            contentType: args.content_type,
            timeoutMs: args.timeout_ms,
            maxBytes: args.max_bytes,
            maxBodyChars: args.max_body_chars,
          },
          ctx,
        );
        return { ok: true, content };
      } catch (error) {
        return fail(error);
      }
    },
  });

  return { httpGet, httpPost };
}
