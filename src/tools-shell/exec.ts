/**
 * The process-execution primitive behind both shell tools: a single
 * `Bun.spawn` wrapper that enforces a timeout, captures stdout/stderr with
 * byte-bounded truncation, and reports the exit code / signal.
 *
 * It has no knowledge of policy, approval, or events — those are layered on in
 * `define.ts`. The only difference between the buffered (`run_command`) and
 * streamed (`spawn_command`) tools is the optional {@link ExecOptions.onChunk}
 * callback, which fires per output chunk as it arrives.
 *
 * @module
 */

import type { CommandResult } from "./types";

/** A streamed output chunk delivered to {@link ExecOptions.onChunk}. */
export interface ExecChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

/** Inputs to {@link execCommand}. */
export interface ExecOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Called for each output chunk as it streams in (used by `spawn_command`). */
  readonly onChunk?: (chunk: ExecChunk) => void;
  /** Caller cancellation (the run's `AbortSignal`); kills the process if aborted. */
  readonly signal?: AbortSignal;
}

/** Drain a byte stream, capping retained bytes and forwarding chunks. */
async function collectStream(
  stream: ReadableStream<Uint8Array> | undefined,
  which: "stdout" | "stderr",
  maxBytes: number,
  onChunk: ((chunk: ExecChunk) => void) | undefined,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === undefined) return { text: "", truncated: false };
  const reader = stream.getReader();
  // A per-call decoder: `{ stream: true }` retains state for multi-byte chars
  // split across chunks, so it must not be shared with the concurrently-running
  // sibling stream or with other overlapping execCommand calls.
  const chunkDecoder = new TextDecoder();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;
      if (onChunk !== undefined) {
        onChunk({ stream: which, text: chunkDecoder.decode(value, { stream: true }) });
      }
      if (keptBytes < maxBytes) {
        const remaining = maxBytes - keptBytes;
        if (value.length <= remaining) {
          kept.push(value);
          keptBytes += value.length;
        } else {
          kept.push(value.subarray(0, remaining));
          keptBytes = maxBytes;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    }
    // Flush any bytes the streaming decoder buffered for an incomplete trailing
    // multi-byte sequence, so the onChunk consumer sees the final character.
    if (onChunk !== undefined) {
      const tail = chunkDecoder.decode();
      if (tail.length > 0) onChunk({ stream: which, text: tail });
    }
  } finally {
    reader.releaseLock();
  }
  // Concatenate kept bytes once, then decode (avoids splitting multi-byte chars).
  const buf = new Uint8Array(keptBytes);
  let offset = 0;
  for (const part of kept) {
    buf.set(part, offset);
    offset += part.length;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

/**
 * Spawn a command and resolve with a structured {@link CommandResult}. Never
 * rejects for a non-zero exit — a failed command is data the model should see.
 * Rejects only if the process cannot be spawned at all (e.g. unknown program).
 */
export async function execCommand(opts: ExecOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: [opts.command, ...opts.args],
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let abortKill = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs);

  const onAbort = () => {
    abortKill = true;
    proc.kill("SIGKILL");
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const [out, err] = await Promise.all([
      collectStream(proc.stdout as ReadableStream<Uint8Array> | undefined, "stdout", opts.maxOutputBytes, opts.onChunk),
      collectStream(proc.stderr as ReadableStream<Uint8Array> | undefined, "stderr", opts.maxOutputBytes, opts.onChunk),
      proc.exited,
    ]);
    return {
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      exitCode: proc.exitCode,
      signal: proc.signalCode ?? null,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    void abortKill; // kill already issued; flag retained for clarity of intent
  }
}
