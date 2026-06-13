import { Buffer } from "node:buffer";

import type { SessionListOptions, SessionListOrder } from "./types";

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 100;

interface CursorPayload {
  readonly version: typeof CURSOR_VERSION;
  readonly prefix?: string;
  readonly order: SessionListOrder;
  readonly offset: number;
}

export interface NormalizedSessionListOptions {
  readonly prefix?: string;
  readonly order: SessionListOrder;
  readonly limit: number;
  readonly offset: number;
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid list cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid list cursor");
  }
  const value = parsed as Partial<CursorPayload>;
  if (
    value.version !== CURSOR_VERSION ||
    (value.prefix !== undefined && typeof value.prefix !== "string") ||
    (value.order !== "recent" && value.order !== "id") ||
    typeof value.offset !== "number" ||
    !Number.isInteger(value.offset) ||
    value.offset < 0
  ) {
    throw new Error("invalid list cursor");
  }
  return {
    version: CURSOR_VERSION,
    ...(value.prefix !== undefined ? { prefix: value.prefix } : {}),
    order: value.order,
    offset: value.offset,
  };
}

export function encodeSessionListCursor(
  options: Pick<NormalizedSessionListOptions, "prefix" | "order"> & { offset: number },
): string {
  const payload: CursorPayload = {
    version: CURSOR_VERSION,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    order: options.order,
    offset: options.offset,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function normalizeSessionListOptions(
  options: SessionListOptions | undefined,
  defaultOrder: SessionListOrder,
): NormalizedSessionListOptions {
  const cursor = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const prefix = options?.prefix ?? cursor?.prefix;
  const order = options?.order ?? cursor?.order ?? defaultOrder;

  if (cursor !== undefined) {
    if (options?.prefix !== undefined && options.prefix !== cursor.prefix) {
      throw new Error("invalid list cursor");
    }
    if (options?.order !== undefined && options.order !== cursor.order) {
      throw new Error("invalid list cursor");
    }
  }

  const rawLimit = options?.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(0, Math.floor(rawLimit));
  return {
    ...(prefix !== undefined ? { prefix } : {}),
    order,
    limit,
    offset: cursor?.offset ?? 0,
  };
}
