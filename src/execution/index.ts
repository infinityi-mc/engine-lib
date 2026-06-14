/**
 * `@infinityi/engine-lib/execution` — the agent run loop.
 *
 * {@link runAgent} executes an {@link AgentDefinition} against its provider
 * using provider-native tool calling, in buffered or streaming mode.
 *
 * @module
 */

export { DEFAULT_MAX_HANDOFFS, DEFAULT_MAX_STEPS, runAgent } from "./run";
export { generateRunId } from "./run-id";
export { addUsage, emptyUsage } from "./usage";
export type {
  AnyRunOptions,
  BufferedRunOptions,
  CheckpointPolicy,
  ResumeOptions,
  RunBridge,
  RunBridgeEvent,
  RunCheckpoint,
  RunEvent,
  RunEventDraft,
  RunHandle,
  RunInput,
  RunOptions,
  RunResult,
  StreamingRunOptions,
} from "./types";
