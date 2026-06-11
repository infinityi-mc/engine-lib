/**
 * Static HTML parsing helpers for `tools-web`.
 *
 * LinkeDOM is used as a local DOM implementation. Scripts are not executed and
 * no browser is launched.
 *
 * @module
 */

import { parseHTML } from "linkedom";

type DomNode = {
  readonly textContent?: string | null;
  getAttribute?(name: string): string | null;
  remove?(): void;
};

type DomDocument = {
  readonly body?: DomNode | null;
  readonly documentElement?: DomNode | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): Iterable<DomNode>;
};

export interface ParsedPage {
  readonly title?: string;
  readonly text: string;
  readonly links: readonly { readonly url: string; readonly text?: string }[];
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function documentFromHtml(html: string): DomDocument {
  return parseHTML(html).document as unknown as DomDocument;
}

function removeNoise(document: DomDocument): void {
  for (const selector of ["script", "style", "noscript", "template", "svg"]) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      node.remove?.();
    }
  }
}

function normalizeUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Parse title, visible-ish text, and absolute links from a static HTML string. */
export function parseStaticHtml(html: string, baseUrl: string, maxLinks = Number.POSITIVE_INFINITY): ParsedPage {
  const document = documentFromHtml(html);
  const title = compactWhitespace(document.querySelector("title")?.textContent ?? "");
  removeNoise(document);
  const root = document.body ?? document.documentElement;
  const text = compactWhitespace(root?.textContent ?? "");
  const links: Array<{ url: string; text?: string }> = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= maxLinks) break;
    if (anchor.getAttribute === undefined) continue;
    const href = anchor.getAttribute("href");
    if (href === null) continue;
    const url = normalizeUrl(href, baseUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const linkText = compactWhitespace(anchor.textContent ?? "");
    links.push({ url, ...(linkText !== "" ? { text: linkText } : {}) });
  }
  return {
    ...(title !== "" ? { title } : {}),
    text,
    links,
  };
}

/** Parse an HTML document for Readability. */
export function readabilityDocument(html: string): unknown {
  return documentFromHtml(html);
}

/** Collapse arbitrary text into a compact model-facing string. */
export function compactText(text: string): string {
  return compactWhitespace(text);
}
