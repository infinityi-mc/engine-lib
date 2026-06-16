# Optional tool packs

## Goal

Add host capabilities such as shell execution, filesystem access, HTTP access,
web retrieval, and sandboxed command execution.

## Prerequisites

- You have read [Tools and schemas](./03-tools-and-schemas.md)
- You understand that these modules are opt-in for safety

## Step 1: Add shell tools

```ts
import { shellTools } from "@infinityi/engine-lib/tools-shell";

const { runCommand, spawnCommand } = shellTools({
  allowedCwds: [process.cwd()],
  policy: { deny: [/\brm\b/, /\bsudo\b/] },
  env: { allow: ["PATH", "HOME"] },
});
```

Use shell tools only when the host intentionally allows command execution.
Built-in controls include cwd allowlists, env filtering, command policy, time
limits, output caps, and optional approval hooks.

## Step 2: Add filesystem tools

```ts
import { filesystemTools } from "@infinityi/engine-lib/tools-fs";

const fsTools = filesystemTools({
  allowedRoots: [process.cwd()],
});
```

This pack exposes prebuilt tools such as repo mapping, file search, text search,
read/write/edit operations, symbol lookup, patching, and diff/status helpers.

## Step 3: Add HTTP tools

```ts
import { httpTools } from "@infinityi/engine-lib/tools-http";

const http = httpTools({
  allowedHosts: ["api.example.com"],
  defaultHeaders: [{ name: "accept", value: "application/json" }],
});
```

Use this pack when the model needs controlled outbound HTTP access. Policies can
restrict hosts, headers, private networks, redirects, protocols, and response
sizes.

## Step 4: Add web tools

```ts
import { webTools } from "@infinityi/engine-lib/tools-web";

const web = webTools({
  allowPublicInternet: true,
  robots: "enforce",
  searchProvider,
});
```

This pack builds on the HTTP client and adds static web fetching, readable text
extraction, crawling, and search-provider integration. It does not launch a
browser or execute JavaScript.

## Step 5: Add a sandbox for shell isolation

```ts
import { shellTools } from "@infinityi/engine-lib/tools-shell";
import { dockerSandbox } from "@infinityi/engine-lib/tools-sandbox";

const { runCommand } = shellTools({
  allowedCwds: [process.cwd()],
  sandbox: dockerSandbox({ image: "alpine:3" }),
});
```

Use `@infinityi/engine-lib/tools-sandbox` when command execution must be
isolated from the host process. Available adapters include:

- `localSandbox`
- `dockerSandbox`

## Step 6: Choose the right pack

Use:

- `tools-shell` for command execution
- `tools-fs` for coding-agent workspace access
- `tools-http` for controlled API access
- `tools-web` for static web/search behavior
- `tools-sandbox` to isolate shell execution

## Result

You should now know how to opt into host capabilities without making the root
library unsafe by default.

## Next steps

- Add retrieval in [Retrieval and memory](./08-retrieval-and-memory.md)
- Add policy, audit, and redaction in [Events, telemetry, and governance](./09-events-telemetry-and-governance.md)
