# Providers

Providers normalize LLM APIs behind one contract: `complete()` for buffered
turns and `stream()` for token/tool-call deltas.

Application imports:

```ts
import {
  createAnthropic,
  createGoogle,
  createOpenAI,
  createOpenAICompatible,
} from "@infinityi/engine-lib/providers";
```

Root imports also expose the built-in factories.

## Built-in factories

```ts
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-5" });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-4-7" });
const google = createGoogle({ apiKey: process.env.GOOGLE_API_KEY!, model: "gemini-2.5-pro" });
const local = createOpenAICompatible({ baseUrl: "http://localhost:1234/v1", model: "local-model" });
```

Provider API keys accept raw strings or Forge `Secret<string>` values.

Runnable real-provider example:
[`../examples/12-provider-openai.ts`](../examples/12-provider-openai.ts).

## Capabilities

Every provider declares:

- `tools`
- `streaming`
- `multimodalInput`
- `parallelToolCalls`
- `structuredOutput`

Treat these as adapter truth and degrade gracefully. For example, a UI can hide
streaming controls when `provider.capabilities.streaming` is false.

## Vendor-specific options

Use normalized request fields first: `temperature`, `topP`,
`maxOutputTokens`, `stopSequences`, `tools`, `toolChoice`, and
`responseSchema`.

Use `providerOptions` only for vendor-specific request body fields that are not
first-classed yet.

## Custom adapters

Advanced imports from `@infinityi/engine-lib/providers` include:

- `createProvider`
- `createProviderHttp`
- `parseSse`
- `StreamAccumulator`
- `collectStream`
- `AdapterSpec`

Adapter authors should also wire the conformance battery from
`@infinityi/engine-lib/testing/conformance`.

