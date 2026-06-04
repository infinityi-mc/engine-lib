/**
 * Bridge to `forge/config` secrets.
 *
 * @module
 */

import { isSecret } from "@infinityi/forge/config";
import type { Secret } from "@infinityi/forge/config";

/**
 * Unwrap a forge {@link Secret} or pass a raw string through, so provider
 * adapters (Phase 2) can accept either an inline key or a config-sourced
 * secret without each adapter re-implementing the check.
 */
export function resolveSecret(value: string | Secret<string>): string {
  return isSecret(value) ? value.unwrap() : value;
}
