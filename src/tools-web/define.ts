/**
 * Higher-level web/search tool definitions.
 *
 * These tools intentionally stay static: they do not execute JavaScript, do not
 * launch a browser, and require an injected search provider for web search.
 *
 * @module
 */

import { Readability } from "@mozilla/readability";
import robotsParser from "robots-parser";

import { s } from "../schema/builder";
import { defineTool } from "../tools/define";
import type { ToolContext, ToolResult } from "../tools/types";
import {
  createHttpToolClient,
  type HttpRequestResult,
  type HttpToolClient,
} from "../tools-http";
import { compactText, parseStaticHtml, readabilityDocument } from "./html";
import type {
  Citation,
  RobotsPolicy,
  SearchResult,
  SourceMetadata,
  WebTools,
  WebToolsConfig,
} from "./types";

interface RobotRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

interface RobotsRecord {
  readonly status: number | "error";
  readonly rules?: RobotRules;
  readonly error?: string;
}

interface PageResult {
  readonly source: SourceMetadata;
  readonly citation: Citation;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly bodyTruncated: boolean;
  readonly html?: string;
  readonly links: readonly { readonly url: string; readonly text?: string }[];
}

const DEFAULT_USER_AGENT = "engine-lib";
const DEFAULT_MAX_SEARCH_RESULTS = 10;
const DEFAULT_MAX_PAGE_TEXT_CHARS = 12_000;
const DEFAULT_MAX_CRAWL_PAGES = 10;
const DEFAULT_MAX_LINKS_PER_PAGE = 25;

const WEB_SEARCH_PARAMS = s.object({
  query: s.string({ description: "Search query." }),
  max_results: s.optional(
    s.number({ int: true, description: "Maximum results to return." }),
  ),
});

const URL_PARAMS = s.object({
  url: s.string({ description: "Absolute http(s) URL." }),
  max_body_chars: s.optional(
    s.number({ int: true, description: "Returned text character cap." }),
  ),
});

const CRAWL_PARAMS = s.object({
  url: s.string({ description: "Absolute http(s) URL to start from." }),
  depth: s.optional(
    s.number({
      int: true,
      description: "Maximum crawl depth from the start URL.",
    }),
  ),
  max_pages: s.optional(
    s.number({ int: true, description: "Maximum pages to fetch." }),
  ),
  max_links_per_page: s.optional(
    s.number({
      int: true,
      description: "Maximum links to keep from each page.",
    }),
  ),
  same_host: s.optional(
    s.boolean({
      description: "Restrict crawl to the start URL host. Defaults to true.",
    }),
  ),
});

type WebSearchArgs = {
  readonly query: string;
  readonly max_results?: number;
};

type UrlArgs = {
  readonly url: string;
  readonly max_body_chars?: number;
};

type CrawlArgs = {
  readonly url: string;
  readonly depth?: number;
  readonly max_pages?: number;
  readonly max_links_per_page?: number;
  readonly same_host?: boolean;
};

function fail(error: unknown): ToolResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value ?? fallback;
  return Math.max(min, Math.min(max, n));
}

function firstSnippet(text: string, max = 240): string | undefined {
  const compact = compactText(text);
  if (compact === "") return undefined;
  return compact.length <= max ? compact : compact.slice(0, max);
}

function isHtml(result: HttpRequestResult): boolean {
  const type = (result.contentType ?? "").toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function isTextLike(result: HttpRequestResult): boolean {
  const type = (result.contentType ?? "").toLowerCase();
  return (
    type.startsWith("text/") || type.includes("json") || type.includes("xml")
  );
}

function titleFromTextFallback(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sourceFor(
  requestedUrl: string,
  result: HttpRequestResult,
  fetchedAt: string,
  title: string | undefined,
  snippet: string | undefined,
  robots: SourceMetadata["robots"] | undefined,
): SourceMetadata {
  return {
    url: requestedUrl,
    finalUrl: result.finalUrl,
    ...(title !== undefined ? { title } : {}),
    fetchedAt,
    ...(result.contentType !== undefined
      ? { contentType: result.contentType }
      : {}),
    status: result.status,
    ...(snippet !== undefined ? { snippet } : {}),
    ...(robots !== undefined ? { robots } : {}),
  };
}

function citationFor(source: SourceMetadata): Citation {
  return {
    url: source.finalUrl,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    fetchedAt: source.fetchedAt,
  };
}

function normalizeSearchResult(
  result: SearchResult,
  fetchedAt: string,
): SearchResult {
  const source: SourceMetadata = result.source ?? {
    url: result.url,
    finalUrl: result.url,
    ...(result.title !== undefined ? { title: result.title } : {}),
    fetchedAt,
    ...(result.snippet !== undefined ? { snippet: result.snippet } : {}),
  };
  return {
    url: result.url,
    ...(result.title !== undefined
      ? { title: result.title }
      : source.title !== undefined
        ? { title: source.title }
        : {}),
    ...(result.snippet !== undefined
      ? { snippet: result.snippet }
      : source.snippet !== undefined
        ? { snippet: source.snippet }
        : {}),
    source,
    citation: result.citation ?? citationFor(source),
  };
}

function robotsPolicyFor(config: WebToolsConfig, url: URL): RobotsPolicy {
  const host = url.hostname.toLowerCase();
  return config.robotsByHost?.[host] ?? config.robots ?? "enforce";
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function robotsUrlFor(url: URL): string {
  return `${originOf(url)}/robots.txt`;
}

function sameHost(url: string, start: URL): boolean {
  try {
    const next = new URL(url);
    return next.hostname.toLowerCase() === start.hostname.toLowerCase();
  } catch {
    return false;
  }
}

function normalizeFetchText(
  result: HttpRequestResult,
  maxChars: number,
): {
  text: string;
  html?: string;
  title?: string;
  links: readonly { readonly url: string; readonly text?: string }[];
  truncated: boolean;
  bodyTruncated: boolean;
} {
  if (typeof result.body === "string" && isHtml(result)) {
    const parsed = parseStaticHtml(result.body, result.finalUrl);
    const limited = result.bodyTruncated || parsed.text.length > maxChars;
    return {
      text: parsed.text.slice(0, maxChars),
      html: result.body,
      title: parsed.title,
      links: parsed.links,
      truncated: limited,
      bodyTruncated: result.bodyTruncated,
    };
  }
  if (typeof result.body === "string") {
    const text = compactText(result.body);
    return {
      text: text.slice(0, maxChars),
      links: [],
      truncated: result.bodyTruncated || text.length > maxChars,
      bodyTruncated: result.bodyTruncated,
    };
  }
  if (result.bodyJson !== undefined) {
    const text = compactText(JSON.stringify(result.bodyJson));
    return {
      text: text.slice(0, maxChars),
      links: [],
      truncated: text.length > maxChars,
      bodyTruncated: result.bodyTruncated,
    };
  }
  return {
    text: "",
    links: [],
    truncated: false,
    bodyTruncated: result.bodyTruncated,
  };
}

function createRobotsChecker(config: WebToolsConfig, http: HttpToolClient) {
  const cache = new Map<string, Promise<RobotsRecord>>();
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;

  async function fetchRobots(
    url: URL,
    ctx: ToolContext,
  ): Promise<RobotsRecord> {
    const origin = originOf(url);
    const cached = cache.get(origin);
    if (cached !== undefined) return cached;

    const promise = (async (): Promise<RobotsRecord> => {
      try {
        const response = await http.get(
          robotsUrlFor(url),
          {
            maxBytes: 512_000,
            maxBodyChars: 512_000,
            headers: [{ name: "user-agent", value: userAgent }],
          },
          ctx,
        );
        if (
          response.status < 200 ||
          response.status >= 300 ||
          typeof response.body !== "string"
        ) {
          return {
            status: response.status,
            rules: robotsParser(robotsUrlFor(url), "") as RobotRules,
          };
        }
        return {
          status: response.status,
          rules: robotsParser(robotsUrlFor(url), response.body) as RobotRules,
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    cache.set(origin, promise);
    return promise;
  }

  return async function checkRobots(
    rawUrl: string,
    ctx: ToolContext,
  ): Promise<SourceMetadata["robots"] | undefined> {
    const url = new URL(rawUrl);
    const policy = robotsPolicyFor(config, url);
    if (policy === "ignore") return { policy };

    const record = await fetchRobots(url, ctx);
    if (record.status === "error") {
      const robots = {
        policy,
        reason: record.error,
      } satisfies SourceMetadata["robots"];
      if (policy === "enforce") {
        throw new Error(
          `robots.txt could not be fetched for ${originOf(url)}: ${record.error}`,
        );
      }
      return robots;
    }

    const allowed = record.rules?.isAllowed(rawUrl, userAgent);
    const isAllowed = allowed !== false;
    const robots = {
      policy,
      allowed: isAllowed,
      ...(!isAllowed ? { reason: "robots.txt disallows this URL" } : {}),
    } satisfies SourceMetadata["robots"];
    if (!isAllowed && policy === "enforce") {
      throw new Error(`robots.txt disallows ${rawUrl}`);
    }
    return robots;
  };
}

/** Build the web/search tools bound to host HTTP and robots policy. */
export function webTools(config: WebToolsConfig): WebTools {
  const http = config.httpClient ?? createHttpToolClient(config);
  const checkRobots = createRobotsChecker(config, http);
  const maxSearchResults =
    config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const maxPageTextChars =
    config.maxPageTextChars ?? DEFAULT_MAX_PAGE_TEXT_CHARS;
  const maxCrawlPages = config.maxCrawlPages ?? DEFAULT_MAX_CRAWL_PAGES;
  const maxLinksPerPage = config.maxLinksPerPage ?? DEFAULT_MAX_LINKS_PER_PAGE;

  async function fetchPageInternal(
    rawUrl: string,
    maxChars: number,
    ctx: ToolContext,
  ): Promise<PageResult> {
    const robots = await checkRobots(rawUrl, ctx);
    const response = await http.get(
      rawUrl,
      {
        maxBodyChars: Math.max(maxChars * 4, maxChars),
        headers: [
          { name: "user-agent", value: config.userAgent ?? DEFAULT_USER_AGENT },
        ],
      },
      ctx,
    );
    const fetchedAt = new Date().toISOString();
    const textInfo = normalizeFetchText(response, maxChars);
    const snippet = firstSnippet(textInfo.text);
    const title = textInfo.title ?? titleFromTextFallback(response.finalUrl);
    const source = sourceFor(
      rawUrl,
      response,
      fetchedAt,
      title,
      snippet,
      robots,
    );
    return {
      source,
      citation: citationFor(source),
      text: textInfo.text,
      textTruncated: textInfo.truncated,
      bodyTruncated: textInfo.bodyTruncated,
      html: textInfo.html,
      links: textInfo.links,
    };
  }

  const webSearch = defineTool<WebSearchArgs>({
    name: "web_search",
    description:
      "Search the web through the host's injected search provider and return normalized citations.",
    policy: { operation: "network", target: (args) => args.query },
    parameters: WEB_SEARCH_PARAMS,
    async execute(args, ctx) {
      try {
        if (config.searchProvider === undefined) {
          return { ok: false, error: "web_search requires a searchProvider" };
        }
        const maxResults = clamp(
          args.max_results,
          maxSearchResults,
          1,
          maxSearchResults,
        );
        const fetchedAt = new Date().toISOString();
        const raw = await config.searchProvider.search(
          { query: args.query, maxResults },
          ctx,
        );
        const results = raw
          .slice(0, maxResults)
          .map((result) => normalizeSearchResult(result, fetchedAt));
        return {
          ok: true,
          content: {
            query: args.query,
            results,
            truncated: raw.length > results.length,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const fetchPage = defineTool<UrlArgs>({
    name: "fetch_page",
    description:
      "Fetch one static HTML/text page and return compact text with source metadata and a citation.",
    policy: { operation: "network", target: (args) => args.url },
    parameters: URL_PARAMS,
    async execute(args, ctx) {
      try {
        const maxChars = clamp(
          args.max_body_chars,
          maxPageTextChars,
          1,
          maxPageTextChars,
        );
        const page = await fetchPageInternal(args.url, maxChars, ctx);
        return {
          ok: true,
          content: {
            source: page.source,
            citation: page.citation,
            text: page.text,
            textTruncated: page.textTruncated,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const extractReadableText = defineTool<UrlArgs>({
    name: "extract_readable_text",
    description:
      "Fetch one static page and extract readable article text, falling back to page text.",
    policy: { operation: "network", target: (args) => args.url },
    parameters: URL_PARAMS,
    async execute(args, ctx) {
      try {
        const maxChars = clamp(
          args.max_body_chars,
          maxPageTextChars,
          1,
          maxPageTextChars,
        );
        const page = await fetchPageInternal(args.url, maxChars, ctx);
        let text = page.text;
        let title = page.source.title;
        let textTruncated = page.textTruncated;
        let readable = false;
        let byline: string | undefined;
        let excerpt: string | undefined;

        if (page.html !== undefined) {
          try {
            const article = new Readability(
              readabilityDocument(page.html) as never,
              {
                charThreshold: 20,
              },
            ).parse();
            const articleText = compactText(article?.textContent ?? "");
            if (articleText !== "") {
              const articleTruncated = articleText.length > maxChars;
              text = articleText.slice(0, maxChars);
              textTruncated = page.bodyTruncated || articleTruncated;
              title = article?.title ?? title;
              byline = article?.byline ?? undefined;
              excerpt = article?.excerpt ?? undefined;
              readable = true;
            }
          } catch {
            readable = false;
          }
        }

        const source: SourceMetadata = {
          ...page.source,
          ...(title !== undefined ? { title } : {}),
          ...(firstSnippet(text) !== undefined
            ? { snippet: firstSnippet(text) }
            : {}),
        };
        return {
          ok: true,
          content: {
            source,
            citation: citationFor(source),
            title,
            text,
            textTruncated,
            readable,
            ...(byline !== undefined ? { byline } : {}),
            ...(excerpt !== undefined ? { excerpt } : {}),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const crawlLinks = defineTool<CrawlArgs>({
    name: "crawl_links",
    description:
      "Fetch a bounded set of static pages and return same-host links by default.",
    policy: { operation: "network", target: (args) => args.url },
    parameters: CRAWL_PARAMS,
    async execute(args, ctx) {
      try {
        const start = new URL(args.url);
        const depth = clamp(args.depth, 1, 0, 5);
        const maxPages = clamp(args.max_pages, maxCrawlPages, 1, maxCrawlPages);
        const linksPerPage = clamp(
          args.max_links_per_page,
          maxLinksPerPage,
          1,
          maxLinksPerPage,
        );
        const requireSameHost = args.same_host ?? true;
        const queue: Array<{ url: string; depth: number }> = [
          { url: start.href, depth: 0 },
        ];
        const queued = new Set<string>([start.href]);
        const seen = new Set<string>();
        let truncated = false;
        const pages: Array<{
          source: SourceMetadata;
          citation: Citation;
          links: readonly { readonly url: string; readonly text?: string }[];
        }> = [];
        const errors: Array<{ url: string; error: string }> = [];

        while (queue.length > 0 && pages.length < maxPages) {
          const next = queue.shift()!;
          queued.delete(next.url);
          if (seen.has(next.url)) continue;
          seen.add(next.url);
          if (requireSameHost && !sameHost(next.url, start)) continue;

          let page: PageResult;
          try {
            page = await fetchPageInternal(next.url, maxPageTextChars, ctx);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (next.depth === 0) throw error;
            errors.push({ url: next.url, error: message });
            continue;
          }

          const eligibleLinks = requireSameHost
            ? page.links.filter((link) => sameHost(link.url, start))
            : page.links;
          const links = eligibleLinks.slice(0, linksPerPage);
          if (eligibleLinks.length > links.length) truncated = true;
          pages.push({ source: page.source, citation: page.citation, links });
          if (next.depth < depth) {
            for (const link of links) {
              if (seen.has(link.url)) continue;
              if (queued.has(link.url)) continue;
              queue.push({ url: link.url, depth: next.depth + 1 });
              queued.add(link.url);
            }
          }
        }

        return {
          ok: true,
          content: {
            startUrl: start.href,
            pages,
            errors,
            truncated: truncated || queue.length > 0,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  return { webSearch, fetchPage, extractReadableText, crawlLinks };
}
