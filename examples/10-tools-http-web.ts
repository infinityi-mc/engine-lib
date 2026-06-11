import type { ToolContext, ToolDefinition, ToolResult } from "@infinityi/engine-lib/tools";
import { httpTools } from "@infinityi/engine-lib/tools-http";
import { webTools, type SearchProvider } from "@infinityi/engine-lib/tools-web";

const html = [
  "<html>",
  "<head><title>Status</title></head>",
  "<body>",
  "<main><h1>Status</h1><p>All public systems are operational.</p></main>",
  "<a href=\"/docs\">Docs</a>",
  "</body>",
  "</html>",
].join("");

const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  if (url.endsWith("/robots.txt")) {
    return new Response("User-agent: *\nAllow: /\n", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (url.endsWith("/status")) {
    return new Response(html, {
      headers: { "content-type": "text/html" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const searchProvider: SearchProvider = {
  search: ({ query, maxResults }) => [
    {
      url: "https://example.com/status",
      title: `Result for ${query}`,
      snippet: `Returning ${maxResults} result(s).`,
    },
  ],
};

const ctx: ToolContext = { toolCallId: "example-web", agentName: "example" };
const http = httpTools({ allowedHosts: ["example.com"], fetch: fakeFetch });
const web = webTools({
  allowedHosts: ["example.com"],
  fetch: fakeFetch,
  searchProvider,
  robots: "enforce",
});

const httpResult = await runTool(http.httpGet, { url: "https://example.com/api" });
const searchResult = await runTool(web.webSearch, { query: "status", max_results: 1 });
const pageResult = await runTool(web.fetchPage, { url: "https://example.com/status" });

console.log({
  http: content(httpResult),
  search: content(searchResult),
  page: content(pageResult),
});

async function runTool<TArgs>(
  tool: ToolDefinition<TArgs>,
  args: TArgs,
): Promise<ToolResult> {
  return tool.execute(args, ctx);
}

function content(result: ToolResult): unknown {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.content;
}

