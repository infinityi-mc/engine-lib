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

