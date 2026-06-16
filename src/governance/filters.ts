import { ExecutionError } from "../errors";
import type { ContentPart, Message, Role, TextPart } from "../messages/types";

export type FilterStage = "provider-input" | "tool-output" | "persistence";

export interface FilterContext {
  readonly stage: FilterStage;
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly role?: Role;
  readonly toolCallId?: string;
}

export type ContentFilter = (
  content: string,
  ctx: FilterContext,
) => string | Promise<string>;

export interface ContentFilterConfig {
  readonly providerInput?: readonly ContentFilter[];
  readonly toolOutput?: readonly ContentFilter[];
  readonly persistence?: readonly ContentFilter[];
  readonly onError?: "redact" | "passthrough" | "error";
}

export interface RedactionPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const REDACTED = "[REDACTED]";

export const defaultRedactionPatterns: readonly RedactionPattern[] = [
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: REDACTED },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: REDACTED },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: REDACTED },
  {
    pattern: /authorization\s*:\s*bearer\s+[^\s,;]+/gi,
    replacement: REDACTED,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: REDACTED,
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  {
    pattern: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
    replacement: REDACTED,
  },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handleFilterError(
  original: string,
  error: unknown,
  onError: ContentFilterConfig["onError"] = "redact",
): string {
  if (onError === "passthrough") return original;
  if (onError === "error") {
    throw new ExecutionError(`content filter failed: ${messageOf(error)}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return REDACTED;
}

export async function applyFilters(
  content: string,
  filters: readonly ContentFilter[] | undefined,
  ctx: FilterContext,
  onError: ContentFilterConfig["onError"] = "redact",
): Promise<string> {
  if (filters === undefined || filters.length === 0) return content;
  let next = content;
  for (const filter of filters) {
    try {
      next = await filter(next, ctx);
    } catch (error) {
      next = handleFilterError(next, error, onError);
    }
  }
  return next;
}

export function regexRedactor(
  patterns: readonly RedactionPattern[] = defaultRedactionPatterns,
): ContentFilter {
  return (content) =>
    patterns.reduce(
      (next, { pattern, replacement }) => next.replace(pattern, replacement),
      content,
    );
}

function redactSensitive(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value))
    return value.map((item) => redactSensitive(item, names));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = names.has(key.toLowerCase())
      ? REDACTED
      : redactSensitive(child, names);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function schemaSensitiveRedactor(
  fieldNames: readonly string[] = [
    "password",
    "secret",
    "token",
    "apiKey",
    "api_key",
    "accessToken",
    "refreshToken",
  ],
): ContentFilter {
  const names = new Set(fieldNames.map((name) => name.toLowerCase()));
  const fields = fieldNames.map(escapeRegExp).join("|");
  const jsonField = new RegExp(
    `"([^"]*(?:${fields})[^"]*)"\\s*:\\s*"[^"]*"`,
    "gi",
  );
  const assignmentField = new RegExp(
    `\\b(?:${fields})\\s*[:=]\\s*[^\\s,;]+`,
    "gi",
  );
  return (content) => {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(content), names));
    } catch {
      return content
        .replace(jsonField, (_match, key: string) => `"${key}":"${REDACTED}"`)
        .replace(assignmentField, REDACTED);
    }
  };
}

async function filterTextPart(
  part: TextPart,
  filters: readonly ContentFilter[] | undefined,
  ctx: FilterContext,
  onError: ContentFilterConfig["onError"],
): Promise<TextPart> {
  const filtered = await applyFilters(part.text, filters, ctx, onError);
  return filtered === part.text ? part : { ...part, text: filtered };
}

export async function filterMessageText(
  message: Message,
  filters: readonly ContentFilter[] | undefined,
  ctx: Omit<FilterContext, "role">,
  onError: ContentFilterConfig["onError"] = "redact",
): Promise<Message> {
  if (filters === undefined || filters.length === 0) return message;
  let changed = false;
  const content: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      const filtered = await filterTextPart(
        part,
        filters,
        { ...ctx, role: message.role },
        onError,
      );
      changed ||= filtered !== part;
      content.push(filtered);
    } else if (part.type === "tool_result") {
      const filteredParts: TextPart[] = [];
      for (const textPart of part.content) {
        const filtered = await filterTextPart(
          textPart,
          filters,
          {
            ...ctx,
            role: message.role,
            toolCallId: part.toolCallId,
          },
          onError,
        );
        changed ||= filtered !== textPart;
        filteredParts.push(filtered);
      }
      content.push(changed ? { ...part, content: filteredParts } : part);
    } else {
      content.push(part);
    }
  }
  return changed ? { ...message, content } : message;
}

export async function filterMessagesText(
  messages: readonly Message[],
  filters: readonly ContentFilter[] | undefined,
  ctx: Omit<FilterContext, "role">,
  onError: ContentFilterConfig["onError"] = "redact",
): Promise<Message[]> {
  if (filters === undefined || filters.length === 0) return [...messages];
  return Promise.all(
    messages.map((message) =>
      filterMessageText(message, filters, ctx, onError),
    ),
  );
}
