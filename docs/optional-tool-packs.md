# Optional tool packs

The root package does not expose file, shell, HTTP, or web access. These modules
are opt-in subpaths and must be configured by the host application.

## Shell tools

Import:

```ts
import { shellTools } from "@infinityi/engine-lib/tools-shell";
```

Safety controls:

- required `allowedCwds`
- environment allow/deny filtering
- command allow/deny policy
- optional approval hook
- timeout and output caps
- audit events for policy, approval, execution, chunks, and errors

Runnable version: [`../examples/11-shell-tools.ts`](../examples/11-shell-tools.ts).

### Sandboxed execution

By default a permitted command runs in-process. To bound its blast radius
(network, filesystem, memory/CPU), pass a `sandbox` to `shellTools`. The sandbox
runs **after** the cwd/command/approval gates pass, so it composes with — it does
not replace — the native policy.

```ts
import { shellTools } from "@infinityi/engine-lib/tools-shell";
import { dockerSandbox } from "@infinityi/engine-lib/tools-sandbox";

const { runCommand } = shellTools({
  allowedCwds: [process.cwd()],
  networkAccess: false, // threaded to the sandbox
  filesystemPaths: ["/work"], // bind-mounted into the container
  memoryLimitMb: 512,
  sandbox: dockerSandbox({ image: "alpine:3" }), // or runtime: "podman"
});
```

- Without `sandbox`, `shellTools` uses the in-process executor directly.
  `localSandbox()` provides that same execution style, but it **fails closed**
  when asked for `networkAccess: false` (unless
  `localSandbox({ allowNetworkDowngrade: true })` is set).
- `dockerSandbox({ image, runtime? })` runs the command in a container with
  `--network none` when `networkAccess` is false, bind mounts for
  `filesystemPaths`, `--memory`/`--cpus` limits, and the same timeout/abort-kill
  behaviour. Requires a working `docker`/`podman` CLI on the host.
- A `SandboxResult` is shape-compatible with `CommandResult`, so the tool's
  result mapping and `shell.exec.*` events are unchanged. A sandbox that cannot
  enforce a requested isolation surfaces as a `ToolFailure`, never an unisolated
  run.

## Filesystem tools

Import:

```ts
import { filesystemTools } from "@infinityi/engine-lib/tools-fs";
```

Capabilities:

- `repo_map`
- `find_files`
- `search_text`
- `search_semantic`
- `symbols`
- `read`
- `open_window`
- `edit_replace`
- `edit_range`
- `apply_patch`
- `write_file`
- `diff_status`

All paths must resolve inside configured `allowedRoots`.

Runnable version:
[`../examples/09-tools-filesystem.ts`](../examples/09-tools-filesystem.ts).

## HTTP tools

Import:

```ts
import { httpTools, createHttpToolClient } from "@infinityi/engine-lib/tools-http";
```

Safety controls:

- explicit `allowedHosts` or `allowPublicInternet`
- denied hosts
- protocol allowlist
- private-network denial by default
- credentialed URL denial by default
- redirect target checks
- model-supplied header allowlist
- timeout, retry, response byte, and body character caps

## Web tools

Import:

```ts
import { webTools } from "@infinityi/engine-lib/tools-web";
```

The web pack builds on the HTTP client and adds:

- `web_search`
- `fetch_page`
- `extract_readable_text`
- `crawl_links`

Search requires an injected `SearchProvider`. No search vendor, browser
automation, JavaScript rendering, cookie jar, or authenticated session handling
is bundled.

Runnable HTTP and web example:
[`../examples/10-tools-http-web.ts`](../examples/10-tools-http-web.ts).
