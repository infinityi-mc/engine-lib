/**
 * Public types for `@infinityi/engine-lib/tools-web`.
 *
 * Web tools sit above `tools-http`: they fetch static HTML/text, normalize
 * search results from an injected provider, extract readable article text, and
 * crawl bounded same-host links.
 *
 * @module
 */

import type { EngineContext } from "../runtime/types";
import type { ToolDefinition } from "../tools/types";
import type { HttpToolClient, HttpToolsConfig } from "../tools-http";

/** Robots handling mode for page fetches and crawling. */
export type RobotsPolicy = "enforce" | "metadata" | "ignore";

/** Request passed to an injected search provider. */
export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
}

/** Search result shape accepted from and returned by web search. */
export interface SearchResult {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly source?: SourceMetadata;
  readonly citation?: Citation;
}

/** Search provider contract. No built-in paid/vendor provider is bundled. */
export interface SearchProvider {
  search(
    request: SearchRequest,
    ctx?: EngineContext,
  ): Promise<readonly SearchResult[]> | readonly SearchResult[];
}

/** Compact source metadata carried by every web result. */
export interface SourceMetadata {
  readonly url: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly fetchedAt: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly snippet?: string;
  readonly robots?: {
    readonly policy: RobotsPolicy;
    readonly allowed?: boolean;
    readonly reason?: string;
  };
}

/** Citation metadata suitable for model-visible attribution. */
export interface Citation {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly fetchedAt: string;
}

/** Configuration for {@link webTools}. */
export interface WebToolsConfig extends HttpToolsConfig {
  /** Optional prebuilt HTTP client. If omitted, one is created from this config. */
  readonly httpClient?: HttpToolClient;
  /** Provider used by `web_search`; omitted providers make only that tool fail. */
  readonly searchProvider?: SearchProvider;
  /** Global robots policy. Defaults to `enforce`. */
  readonly robots?: RobotsPolicy;
  /** Per-host robots policy overrides, keyed by lower-case hostname. */
  readonly robotsByHost?: Readonly<Record<string, RobotsPolicy>>;
  /** User-Agent used for robots checks and optional default request headers. */
  readonly userAgent?: string;
  /** Upper bound for `web_search.max_results`. Defaults to 10. */
  readonly maxSearchResults?: number;
  /** Upper bound for returned page text. Defaults to 12_000 characters. */
  readonly maxPageTextChars?: number;
  /** Upper bound for crawl pages. Defaults to 10. */
  readonly maxCrawlPages?: number;
  /** Upper bound for links returned per crawled page. Defaults to 25. */
  readonly maxLinksPerPage?: number;
}

/** The ready-made web tool definitions. */
export interface WebTools {
  readonly webSearch: ToolDefinition;
  readonly fetchPage: ToolDefinition;
  readonly extractReadableText: ToolDefinition;
  readonly crawlLinks: ToolDefinition;
}
