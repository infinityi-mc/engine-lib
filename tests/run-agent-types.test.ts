import { describe, expect, it } from "bun:test";

import { defineAgent } from "../src/agent/index";
import {
  runAgent,
  type AnyRunOptions,
  type BufferedRunOptions,
  type RunHandle,
  type RunResult,
  type StreamingRunOptions,
} from "../src/execution/index";
import { mockProvider } from "../src/testing/index";

const agent = defineAgent({ name: "typed", provider: mockProvider() });

function assertRunAgentTypes(): void {
  const buffered = runAgent(agent, { input: "hi" });
  const explicitBufferedOpts: BufferedRunOptions = {
    input: "hi",
    stream: false,
  };
  const explicitBuffered = runAgent(agent, explicitBufferedOpts);

  const streaming = runAgent(agent, { input: "hi", stream: true });
  const explicitStreamingOpts: StreamingRunOptions = {
    input: "hi",
    stream: true,
  };
  const explicitStreaming = runAgent(agent, explicitStreamingOpts);

  const dynamicOpts: AnyRunOptions = {
    input: "hi",
    stream: Math.random() > 0.5,
  };
  const dynamic = runAgent(agent, dynamicOpts);

  const bufferedResult: Promise<RunResult> = buffered;
  const explicitBufferedResult: Promise<RunResult> = explicitBuffered;
  const streamingResult: RunHandle = streaming;
  const explicitStreamingResult: RunHandle = explicitStreaming;
  const dynamicResult: Promise<RunResult> | RunHandle = dynamic;

  void [
    bufferedResult,
    explicitBufferedResult,
    streamingResult,
    explicitStreamingResult,
    dynamicResult,
  ];

  // @ts-expect-error streaming mode returns RunHandle, not Promise<RunResult>.
  const badStreamingPromise: Promise<RunResult> = streaming;
  // @ts-expect-error buffered mode returns Promise<RunResult>, not RunHandle.
  const badBufferedHandle: RunHandle = buffered;
  void [badStreamingPromise, badBufferedHandle];
}

describe("runAgent type contract", () => {
  it("keeps buffered and streaming overloads distinct", () => {
    void assertRunAgentTypes;
    expect(true).toBe(true);
  });
});
