/**
 * `@infinityi/engine-lib/tools-web` - optional static web/search tools.
 *
 * This subpath builds on `tools-http` and remains opt-in. It ships no search
 * vendor adapter and does not execute JavaScript or launch a browser.
 *
 * @example
 * ```ts
 * import { webTools } from "@infinityi/engine-lib/tools-web";
 *
 * const web = webTools({
 *   allowPublicInternet: true,
 *   robots: "enforce",
 *   searchProvider,
 * });
 * ```
 *
 * @module
 */

export { webTools } from "./define";

export type {
  Citation,
  RobotsPolicy,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SourceMetadata,
  WebTools,
  WebToolsConfig,
} from "./types";
