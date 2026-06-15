/**
 * {@link localSandbox} — the default {@link ToolSandbox}, a thin pass-through to
 * the in-process executor (`execCommand`). It reproduces today's shell
 * behaviour exactly: streamed `onChunk`, timeout, byte caps, and abort-kill.
 *
 * An in-process spawn cannot enforce network or filesystem isolation, so a
 * request for `networkAccess: false` fails closed (a {@link SandboxError}) unless
 * the host explicitly opts into the downgrade via `allowNetworkDowngrade` — the
 * command is never silently run unisolated.
 *
 * @module
 */

import { SandboxError } from "../errors";
import { execCommand } from "../tools-shell/exec";
import type { SandboxOptions, SandboxResult, ToolSandbox } from "./types";

/** Options for {@link localSandbox}. */
export interface LocalSandboxOptions {
  /**
   * Permit running unisolated when an isolation guarantee (e.g. no network)
   * cannot be enforced in-process. Defaults to `false` (fail closed).
   */
  readonly allowNetworkDowngrade?: boolean;
}

/**
 * The default in-process sandbox. Delegates to `execCommand`, preserving exact
 * current shell behaviour. Fails closed on un-enforceable isolation requests.
 */
export function localSandbox(opts: LocalSandboxOptions = {}): ToolSandbox {
  const allowNetworkDowngrade = opts.allowNetworkDowngrade ?? false;
  return {
    async execute(
      command: string,
      args: readonly string[],
      options: SandboxOptions,
    ): Promise<SandboxResult> {
      if (!options.networkAccess && !allowNetworkDowngrade) {
        throw new SandboxError(
          "localSandbox cannot enforce networkAccess:false in-process; " +
            "pass { allowNetworkDowngrade: true } to run unisolated or use dockerSandbox",
        );
      }
      return execCommand({
        command,
        args,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        ...(options.onChunk !== undefined ? { onChunk: options.onChunk } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    },
  };
}
