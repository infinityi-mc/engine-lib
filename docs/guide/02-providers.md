# Providers

## Goal

Choose a provider, understand the normalized provider contract, and know when to
use the advanced provider subpath.

## Prerequisites

- You have read [Getting started](./01-getting-started.md)
- You know how to create and run a basic agent

## Step 1: Use a built-in provider factory

```ts
import {
  createAnthropic,
  createGoogle,
  createOpenAI,
  createOpenAICompatible,
} from "@infinityi/engine-lib/providers";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-4-7",
});

const google = createGoogle({
  apiKey: process.env.GOOGLE_API_KEY!,
  model: "gemini-2.5-pro",
});

const local = createOpenAICompatible({
  baseUrl: "http://localhost:1234/v1",
  model: "local-model",
});
```

Root imports also expose the four shipped provider factories.

## Step 2: Understand the normalized contract

All providers implement the same logical contract:

- `complete()` for buffered responses
- `stream()` for streaming responses
- `capabilities` to declare supported behavior
- `defaultModel` and `name` for identity and defaults

This lets application code stay provider-agnostic while still adapting to each
provider's actual capabilities.

## Step 3: Read capability flags before assuming features

Each provider declares a `ProviderCapabilities` object with:

- `tools`
- `streaming`
- `multimodalInput`
- `parallelToolCalls`
- `structuredOutput`

Use these flags as truth. For example, hide streaming UI when
`provider.capabilities.streaming` is `false`.

## Step 4: Prefer normalized request options

When driving providers through `runAgent`, prefer the common request model:

- `temperature`
- `topP`
- `maxOutputTokens`
- `stopSequences`
- `tools`
- `toolChoice`
- `responseSchema`

Use provider-specific request fields only when the normalized surface does not
cover what you need.

## Step 5: Use the provider subpath for adapter work

Advanced integrations live in `@infinityi/engine-lib/providers`:

- `createProvider`
- `createProviderHttp`
- `collectStream`
- `StreamAccumulator`
- `parseSse`
- `openSseStream`
- `defaultProviderResilience`
- `toProviderError`
- `DEFAULT_TIMEOUT_MS`

Use these when you are building a custom adapter, transport wrapper, or test
harness. Most applications should not need them.

## Result

You should now know how to:

- choose a shipped provider
- stay on the normalized contract
- gate behavior using capabilities
- reach for the provider subpath only for adapter work

## Next steps

- Define schema-validated tools in [Tools and schemas](./03-tools-and-schemas.md)
- Learn the execution loop in [Execution](./04-execution.md)
