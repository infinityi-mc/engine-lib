/**
 * Pure policy functions for the `tools-shell` module: working-directory
 * allowlisting, environment filtering, and command allow/deny classification.
 *
 * Everything here is side-effect-free and independently unit-testable — no
 * spawning, no filesystem access. The tool's `execute` composes these gates
 * before any process is created.
 *
 * @module
 */

import { isAbsolute, relative, resolve } from "node:path";

import { ShellPolicyError } from "../errors";
import type {
  CommandPattern,
  EnvPolicy,
  ShellPolicy,
} from "./types";

/** Validate `allowedCwds` at factory-build time; throws on misconfiguration. */
export function normalizeAllowedCwds(allowedCwds: readonly string[]): string[] {
  if (!Array.isArray(allowedCwds) || allowedCwds.length === 0) {
    throw new ShellPolicyError(
      "shellTools: `allowedCwds` must be a non-empty array of absolute paths",
    );
  }
  return allowedCwds.map((dir) => {
    if (typeof dir !== "string" || !isAbsolute(dir)) {
      throw new ShellPolicyError(
        `shellTools: allowedCwds entry must be an absolute path, got ${JSON.stringify(dir)}`,
      );
    }
    return resolve(dir);
  });
}

/**
 * Resolve a requested cwd against the allowlist. Returns the absolute path when
 * it is one of the allowed roots or a descendant; returns `null` when it
 * escapes every root. `requested` is resolved relative to the *first* allowed
 * root when given as a relative path, so a bare `"."` maps into the sandbox
 * rather than the host process cwd.
 */
export function resolveCwd(
  requested: string | undefined,
  allowedRoots: readonly string[],
): string | null {
  const base = allowedRoots[0]!;
  const abs = requested === undefined ? base : resolve(base, requested);
  for (const root of allowedRoots) {
    const rel = relative(root, abs);
    // Inside `root` iff the relative path doesn't climb out (`..`) and isn't absolute.
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  }
  return null;
}

/** Test a command line against a single pattern. */
function matchesPattern(
  pattern: CommandPattern,
  command: string,
  commandLine: string,
): boolean {
  // Strings match the program (argv[0]) exactly; regexes test the full line.
  return typeof pattern === "string"
    ? pattern === command
    : pattern.test(commandLine);
}

/**
 * Decide whether a command is permitted by the allow/deny policy. Deny wins:
 * a command matching any `deny` entry is rejected even if also allowed. When
 * `allow` is present, the command must match at least one allow entry.
 */
export function classifyCommand(
  command: string,
  args: readonly string[],
  policy: ShellPolicy | undefined,
): { allowed: boolean; reason?: string } {
  if (policy === undefined) return { allowed: true };
  const commandLine = [command, ...args].join(" ");

  if (policy.deny?.some((p) => matchesPattern(p, command, commandLine))) {
    return { allowed: false, reason: `command "${command}" is denied by policy` };
  }
  if (policy.allow !== undefined) {
    const ok = policy.allow.some((p) => matchesPattern(p, command, commandLine));
    if (!ok) {
      return { allowed: false, reason: `command "${command}" is not in the allow-list` };
    }
  }
  return { allowed: true };
}

/**
 * Build the environment for a spawned command from the host process env and an
 * {@link EnvPolicy}. With no `allow` list, **no** inherited variables are passed
 * (only `extra`). `deny` strips names even when allowed; `extra` is merged last.
 */
export function filterEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  policy: EnvPolicy | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const deny = new Set(policy?.deny ?? []);

  for (const name of policy?.allow ?? []) {
    if (deny.has(name)) continue;
    const value = processEnv[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(policy?.extra ?? {})) {
    if (deny.has(name)) continue;
    out[name] = value;
  }
  return out;
}
