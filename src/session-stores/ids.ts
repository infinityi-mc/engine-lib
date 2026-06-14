import { createHash } from "node:crypto";

const VALID_TABLE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertTablePrefix(prefix: string): string {
  if (!VALID_TABLE_PREFIX_RE.test(prefix)) {
    throw new Error(
      `Invalid session store table prefix: ${JSON.stringify(prefix)}`,
    );
  }
  return prefix;
}

export function safeSessionKey(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function sessionFileName(id: string): string {
  return `${createHash("sha256").update(id).digest("hex")}.jsonl`;
}
