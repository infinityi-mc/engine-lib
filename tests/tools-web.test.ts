import { describe, expect, it } from "bun:test";

import type { ToolContext, ToolDefinition, ToolResult } from "../src/tools/types";
import { webTools, type SearchProvider } from "../src/tools-web/index";

function ctx(): ToolContext {
  return { toolCallId: "call-web" };
}

async function run(tool: ToolDefinition, args: unknown): Promise<ToolResult> {
  return tool.execute(args as never, ctx());
}

function routedFetch(routes: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = routes[url];
    if (response === undefined) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    return typeof response === "function" ? response() : response.clone();
  }) as typeof fetch;
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

describe("web_search", () => {
  it("normalizes injected provider results and clamps max_results", async () => {
    const provider: SearchProvider = {
      search: ({ maxResults }) => [
        { url: "https://example.com/a", title: "A", snippet: `max ${maxResults}` },
        { url: "https://example.com/b", title: "B" },
        { url: "https://example.com/c", title: "C" },
      ],
    };
    const web = webTools({
      allowedHosts: ["example.com"],
      searchProvider: provider,
      maxSearchResults: 2,
      fetch: routedFetch({}),
    });

    const res = await run(web.webSearch, { query: "docs", max_results: 99 });
    expect(res.ok).toBe(true);
    const content = (res as { content: { results: Array<{ source: unknown; citation: unknown }> } }).content;
    expect(content.results).toHaveLength(2);
    expect(content.results[0]?.source).toBeDefined();
    expect(content.results[0]?.citation).toBeDefined();
  });
});

describe("fetch_page and extract_readable_text", () => {
  it("returns compact text, title, source metadata, and citation for static HTML", async () => {
    const web = webTools({
      allowedHosts: ["example.com"],
      fetch: routedFetch({
        "https://example.com/robots.txt": new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        }),
        "https://example.com/page": html(`
          <html>
            <head><title>Example Page</title><script>ignored()</script></head>
            <body><h1>Hello World</h1><p>Useful page text.</p></body>
          </html>
        `),
      }),
    });

    const res = await run(web.fetchPage, { url: "https://example.com/page" });
    expect(res.ok).toBe(true);
    const content = (res as { content: { source: { title?: string }; citation: { url: string }; text: string } }).content;
    expect(content.source.title).toBe("Example Page");
    expect(content.citation.url).toBe("https://example.com/page");
    expect(content.text).toContain("Hello World");
    expect(content.text).not.toContain("ignored");
  });

  it("extracts readable article text and falls back cleanly when extraction fails", async () => {
    const articleText = "Main article sentence with enough useful content for readability. ".repeat(8);
    const web = webTools({
      allowedHosts: ["example.com"],
      fetch: routedFetch({
        "https://example.com/robots.txt": new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        }),
        "https://example.com/article": html(`
          <html><head><title>Outer Title</title></head>
          <body><nav>nav text</nav><article><h1>Readable Title</h1><p>${articleText}</p></article></body></html>
        `),
        "https://example.com/plain": new Response("plain fallback text", {
          headers: { "content-type": "text/plain" },
        }),
      }),
    });

    const article = await run(web.extractReadableText, { url: "https://example.com/article" });
    expect(article.ok).toBe(true);
    const articleContent = (article as { content: { readable: boolean; text: string } }).content;
    expect(articleContent.readable).toBe(true);
    expect(articleContent.text).toContain("Main article sentence");

    const fallback = await run(web.extractReadableText, { url: "https://example.com/plain" });
    expect(fallback.ok).toBe(true);
    const fallbackContent = (fallback as { content: { readable: boolean; text: string } }).content;
    expect(fallbackContent.readable).toBe(false);
    expect(fallbackContent.text).toBe("plain fallback text");
  });

  it("does not mark exact-length readable text as truncated", async () => {
    const articleText = "Exact readable content for truncation check.";
    const web = webTools({
      allowedHosts: ["example.com"],
      fetch: routedFetch({
        "https://example.com/robots.txt": new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain" },
        }),
        "https://example.com/exact": html(`
          <html><head><title>Exact</title></head>
          <body><article><p>${articleText}</p></article></body></html>
        `),
      }),
    });

    const res = await run(web.extractReadableText, {
      url: "https://example.com/exact",
      max_body_chars: articleText.length,
    });
    expect(res.ok).toBe(true);
    const content = (res as { content: { readable: boolean; text: string; textTruncated: boolean } }).content;
    expect(content.readable).toBe(true);
    expect(content.text).toBe(articleText);
    expect(content.textTruncated).toBe(false);
  });
});

describe("crawl_links", () => {
  it("respects depth/page/link limits, same-host default, dedupe, and robots denial", async () => {
    const fetched: string[] = [];
    const routes = {
      "https://example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /blocked\nAllow: /\n", {
        headers: { "content-type": "text/plain" },
      }),
      "https://example.com/start": () => {
        fetched.push("start");
        return html(`
          <html><head><title>Start</title></head><body>
            <a href="/a">A</a>
            <a href="/a#fragment">A duplicate</a>
            <a href="/blocked">Blocked</a>
            <a href="https://other.example/out">External</a>
          </body></html>
        `);
      },
      "https://example.com/a": () => {
        fetched.push("a");
        return html(`<html><head><title>A</title></head><body><a href="/deeper">Deep</a></body></html>`);
      },
      "https://example.com/blocked": () => {
        fetched.push("blocked");
        return html("blocked");
      },
    };
    const web = webTools({
      allowedHosts: ["example.com"],
      fetch: routedFetch(routes),
      maxCrawlPages: 5,
    });

    const res = await run(web.crawlLinks, {
      url: "https://example.com/start",
      depth: 1,
      max_pages: 5,
      max_links_per_page: 3,
    });
    expect(res.ok).toBe(true);
    const content = (res as { content: { pages: unknown[]; errors: Array<{ url: string; error: string }>; truncated: boolean } }).content;
    expect(content.pages).toHaveLength(2);
    expect(content.errors[0]?.url).toBe("https://example.com/blocked");
    expect(content.errors[0]?.error).toContain("robots.txt disallows");
    expect(content.truncated).toBe(false);
    expect(fetched).toEqual(["start", "a"]);
  });
});
