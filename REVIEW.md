## 🔵 Flag - Investigate

(Each item is a question that needs author confirmation. The "if not" tail
shows what becomes a real bug if the answer is "no".)

#### I1. `Schema._output` phantom field is dead — `src/schema/types.ts:64-65`

JSDoc claims `_output` is the type-only marker used by `Infer`, but `Infer` extracts `T` from the generic parameter, not from the field. Repo-wide search shows no reader. _If not dead, then a downstream `Schema<T>` consumer without the generic binding gets the wrong `T`._ **Fix:** Remove or actually use it in `Infer`.

#### I2. `s.optional` does not treat `null` as "absent" — `src/schema/builder.ts:142-158`

The wrapped schema's `safeParse` short-circuits on `undefined` only. JSON Schema convention is `type: ["string", "null"]`; some LLM providers emit `null` for omitted optional fields. _If providers do emit `null`, then tool calls with `{"limit": null}` fail validation despite "no value" semantics._ **Fix:** Accept `null` as another sentinel in `safeParse` and optionally emit `type: [<inner>, "null"]`.

#### I3. Forge subpath imports in `runtime/types.ts` are unverified — `src/runtime/types.ts:11-12`

Imports from `@infinityi/forge/telemetry` and `@infinityi/forge/telemetry/log`. `node_modules/@infinityi/forge` is not present in the repo, and the lockfile entry doesn't reveal exports. _If forge doesn't expose these, the build fails._ **Fix:** Confirm in forge's `package.json#exports`.

#### I4. `system()` only accepts a string while `user`/`assistant` accept `string | ContentPart[]` — `src/messages/factory.ts:26` vs `:31, :36`

Inconsistent. _If hosts need multimodal system prompts, they hand-build a `Message` and bypass the factory._ **Fix:** Align `system` with `user`/`assistant` (or document the limitation).

#### I5. `ImagePart.data` is unvalidated at construction — `src/messages/types.ts:42-46`

No factory exists; `data` is a free-form `string`; no check that the value is a valid base64 blob, data URL, or http(s) URL. _If providers are strict, invalid/malicious payloads (`javascript:` URLs, oversized data) reach providers unchanged._ **Fix:** Add an `image(...)` factory that validates `data` shape.

#### I6. Rate-limiter reservation is not released on cancellation — `src/execution/run.ts:438-454` (`acquireProviderRateLimit`)

`waitWithAbort(acquire, opts.signal)` rejects on abort, but the underlying `RateLimiter.acquire` may have already incremented its internal counter (e.g. `fixedWindowRateLimiter` reserves the slot _before_ returning the resolved promise). The abort unwinds the run, the slot stays consumed until the window resets. _If cancel-heavy, the effective rate permanently degrades._ **Fix:** `release(weight)` on the `RateLimiter` interface, or make `acquire` perform reservation only after the wait completes.

#### I7. Tool-emitted `CancelledError` is downgraded to a generic error — `src/execution/run.ts:611-621`

A tool that throws `CancelledError` is only treated as cancellation if `opts.signal?.aborted` is also true. A tool that cancels for its own reasons is converted to `ok: false` and the run continues. _If a tool legitimately needs to abort the parent run (timeout-gated shell exec, sub-agent inner signal), the parent keeps going and may call the same tool again._ **Fix:** Also treat a `CancelledError` from the tool as cancellation if the `engineCtx.signal` is aborted.

#### I8. `trailingDanglingToolCalls` only inspects the last assistant turn — `src/execution/run.ts:137-155`

Resume reconciliation walks backward and stops at the first non-tool message. If the tail is a tool result and the assistant that requested it is earlier, that assistant's tool calls are not reconciled. _If a session crashed mid-tool-dispatch with multiple in-flight tool calls and only some results persisted, the resumed run fails on the next provider call._ **Fix:** Iterate backward and reconcile every trailing assistant turn whose tool calls are not all matched.

#### I9. `writeResumeStatus` read-modify-write is non-atomic — `src/execution/run.ts:1009-1034`

`getMetadata` then `setMetadata` is a non-atomic RMW. Two concurrent writers can clobber each other. _If a parallel sub-agent is writing its own metadata, resume data is silently lost._ **Fix:** `setMetadataIfVersion` on the CAS store.

#### I10. OpenAI `toInputItems` emits bare `function_call` items without a wrapping assistant turn — `src/providers/openai/map.ts:86-104`

When the prior assistant message has only tool calls (no text), no `{ role: "assistant", content: textParts }` entry is created; the function calls are emitted as top-level `function_call` items. _If the Responses API requires these to live inside an assistant turn, resume fails._ **Fix:** Always emit an assistant item, or document the deviation.

#### I11. Provider conformance suite does not exercise streaming error paths — `tests/providers/conformance.test.ts`, `tests/providers/contract.test.ts:216-241`

No per-adapter fixture for: a stream that emits an `error` event and ends, a body that closes mid-chunk, a 5xx that must be retried then succeed, a stream that omits the terminal `finish` event. _If the fallback `finish` emission path is broken, no test catches it._ **Fix:** Add `streamingError` and `truncatedBody` fixtures.

#### I12. `dockerSandbox` `image` is not pinned to a digest — `src/tools-sandbox/docker.ts:24`

A tag like `alpine:3` is mutable. The code does not pass `--pull=never`, does not resolve to a digest, and does not verify signatures. _If the registry is compromised, the host's audit trail says "ran alpine:3" but the executed bytes are attacker-controlled._ **Fix:** Document the pinning requirement, or accept an `image: { repo, digest }` shape and append `@sha256:...` internally.

#### I13. `dockerSandbox` `workdir` fallback trusts `cwd` as an in-container path — `src/tools-sandbox/docker.ts:49-50`

The shell module gates `cwd` through `resolveCwd`, but `buildRunArgs` does not. _If a host constructs `SandboxOptions` outside the shell tool, a malicious `cwd` (e.g. `-w /etc`) is a valid docker flag._ **Fix:** Re-validate in `buildRunArgs`.

#### I14. `dockerSandbox` `filesystemPaths` is not path-normalised — `src/tools-sandbox/docker.ts:46-47`

Each `path` is concatenated into `-v ${path}:${path}` without resolving symlinks, `..` segments, or rejecting absolute-but-sensitive paths like `/`, `/etc`, `/var/run/docker.sock`, `/proc`, `/sys`. _If a host forwards model-supplied paths (the public `ToolSandbox` contract doesn't forbid it), the docker socket can be mounted and the container controls the docker daemon._ **Fix:** `path.resolve` each entry, reject anything not in an allowlist, reject `/proc`, `/sys`, `*/docker.sock`.

#### I15. `-e ${key}=${value}` parsing if value starts with `-` — `src/tools-sandbox/docker.ts:51-52`

A value starting with `-` (e.g. `extra: { X: "-it" }`) becomes a docker CLI flag token. _Uncertain — depends on the targeted docker/podman CLI's argument parser._ **Fix:** Strip or reject values with leading `-`.

#### I16. `docker run` cleanup on outer kill is best-effort — `src/tools-sandbox/docker.ts:78-91`

If the CLI is killed _during_ `docker run` argument parse, the container may be created without a corresponding `rm`. _Bursts of timeouts can leave dangling containers consuming `--memory` and filling the host's disk with container layers._ **Fix:** Post-execution `docker rm -f <id>` sweep.

#### I17. `localSandbox.allowNetworkDowngrade` is silent — no audit event — `src/tools-sandbox/local.ts:40-55`

When a host opts into `allowNetworkDowngrade: true`, the command runs unisolated. Neither the `shell.exec.start` nor the `shell.exec.end` event marks the run as "network isolation was requested but not enforced". _Compliance / post-incident review misses a downgrade._ **Fix:** Emit a dedicated `shell.sandbox.downgrade` event.

#### I18. `abortKill` flag is dead — `CommandResult` cannot distinguish timeout from abort — `src/tools-shell/exec.ts:111, 119, 159`

`abortKill` is set in the abort path but never read (`void abortKill`). The result's `signal` and `exitCode` are the same shape for both cases. _Observability gap — model/host can't tell from the result whether the process was killed by timeout or by the run's cancellation signal._ **Fix:** Add `aborted: boolean` to `CommandResult` and surface it in `shell.exec.end`.

#### I19. `resolveCwd` does not resolve symlinks — escape via symlink in allowed root — `src/tools-shell/policy.ts:47-59`

A directory inside an allowed root that contains `link -> /etc` allows the model to `cat link/passwd` from any path the symlink resolves to. _Default factory is vulnerable to an attacker who can create a symlink inside the host's `allowedCwds` (low bar in multi-tenant dev environments)._ **Fix:** Default `normalizeAllowedCwds` to `fs.realpathSync` each root, or re-validate on every request.

#### I20. `classifyCommand` regex is tested against `commandLine` (argv joined) — argument-injection concerns inside an allow-by-regex policy — `src/tools-shell/policy.ts:82-108`

With `allow: [/^git /]` a model can pass `args: ["-c", "core.fsmonitor=evil", ...]`. Not command injection, but the model can flip git's behaviour (`-c key=val`, `-c uploadpack.command=...`). _A naive allow-by-program regex is not a security boundary._ **Fix:** Document the distinction; optionally expose `argv0: CommandPattern` that matches only the program name.

#### I21. `execCommand` may leak `Bun.spawn` errors that contain argv — `src/tools-shell/exec.ts:101-160`, `define.ts:258-265`

The `catch` reads `err.message` and includes it in both the returned `ToolResult.error` and the `shell.exec.end` audit event. Bun's spawn errors usually say "ENOENT", but on some failures the message can include the argv. **Fix:** Map to a generic "failed to spawn" string.

#### I22. `CommandResult` carries no policy decision / classification metadata — `src/tools-shell/types.ts:38-58`

No field recording which policy matched, what timeout was effective, or whether the request went through a sandbox. _If a run is replayed from a partial log, the result alone cannot establish provenance._ **Fix:** Add `sandboxed: boolean`, `policyDecision`, or a hash of the policy snapshot.

#### I23. TOCTOU in filesystem: `realpathSync` is called once during policy resolution; the returned path is re-used at the call site — `src/tools-fs/policy.ts:155-202` vs `src/tools-fs/define.ts:558, 684, 740, 812, 886`

A local actor with FS write access in the window between check and use can swap a regular file for a symlink that resolves outside the root. _Reads from the model can leak the contents of an external symlink target that wasn't present at policy time. `expected_file_version` closes part of this for edits, not for reads._ **Fix:** Re-open with `O_NOFOLLOW` (POSIX), or re-`realpath` immediately before the syscall.

#### I24. Secret / query-string leakage in HTTP audit events — `src/tools-http/events.ts:29-50`

The full request URL — including query string — is emitted in `http.policy` and `http.request.start`. URLs commonly carry tokens (`?api_key=…`). _If a host forwards these events to logs or displays them to the model, query-string secrets leave the trust boundary._ **Fix:** Strip or redact `key`/`token`/`signature` params before emitting.

#### I25. `runValidationCommand` hook can run arbitrary host commands — `src/tools-fs/types.ts:33-37, 232-238` and `src/tools-fs/define.ts:222-238`

The model supplies arbitrary command strings in `validate.tests`. The library passes them to a host-injected `runValidationCommand` with no contract beyond "you handle it." _If the host hook shells out unsanitized, a model can run `validate.tests: ["rm -rf $HOME"]`._ **Fix:** Document the contract more loudly, or accept a structured `[{ name, argv, cwd }]`.

#### I26. `*.example.com` pattern does not match apex `example.com` — `src/tools-http/policy.ts:199-222` (`matchesHost`)

Apex denial encourages operators to broaden to `*`. _Allowed requests to the apex host are denied with a confusing error, encouraging dangerous over-broadening._ **Fix:** Treat `*.example.com` as also matching `example.com`.

#### I27. IDN / punycode not normalized in host matching — `src/tools-http/policy.ts:187-193`

`https://еxample.com` (Cyrillic `е`) keeps a Unicode hostname in `URL` and is matched as a distinct string. _Combined with `allowPublicInternet: true` and a `deniedHosts` list, a visually-identical Unicode hostname can reach the host._ **Fix:** Normalize via `punycode.toASCII` before matching.

#### I28. `find_files` regex mode also exposes ReDoS — `src/tools-fs/define.ts:409-411`

Same surface as S19 but bounded by entry count. **Fix:** Same as S19.

#### I29. NTFS alternate data streams not blocked — `src/tools-fs/policy.ts:155-202`

On Windows, paths of the form `C:\root\file.txt:secret` are treated as a single string. `path.relative` and `realpathSync` do not validate the ADS separator. **Fix:** Reject any input path containing `:` not already part of a drive letter.

#### I30. `asTool` does not propagate `maxSteps` / `maxHandoffs` to child — `src/agent/as-tool.ts:89-108`

A sub-agent has its own defaults. _If the parent has `maxHandoffs: 2`, the sub-agent can still do 8 handoffs internally._ **Fix:** Forward at least the handoff/step caps.

#### I31. `onStart` / `onFinish` hooks not fired for handoff-target agents — `src/agent/*` and `src/execution/run.ts:1258, 1431`

The new agent has no hook to know it was just entered. _If hooks are used for setup (e.g., load resources) or cleanup, intermediate agents in a handoff chain leak._ **Fix:** Fire `onStart` for the new active agent; fire `onFinish` on the source agent when handing off.

#### I32. Lifecycle `start()` / `stop()` not idempotent — `src/lifecycle/component.ts:140-160`

Calling `start` twice re-validates and re-probes; `onStop` runs on every `stop`. _Whether Forge enforces single-invocation is a contract question._ **Fix:** Track a "started"/"stopped" state and short-circuit.

#### I33. `onStop` failure in the lifecycle component propagates without logging — `src/lifecycle/component.ts:157-160`

`await onStop(ctx.signal)` — if it throws, the Forge stop sequence is interrupted. **Fix:** Wrap in try/catch and log; continue the stop sequence.

#### I34. Agent names that contain provider-rejected characters generate invalid handoff tool names — `src/agent/handoff.ts:33-58`, `src/agent/define.ts:38-46`

`transfer_to_<name>` includes the raw agent name. If `<name>` contains spaces or dots, most providers reject the tool name. `defineAgent` only checks non-empty. **Fix:** Restrict name format to a provider-safe pattern (e.g. `[a-zA-Z0-9_-]+`).

#### I35. `setExpiry` not atomic across 3 Redis keys — `src/session-stores/redis.ts`

`Promise.all` of three `pExpire` calls. _If one succeeds and another fails, the session has partial expiry._ **Fix:** Lua script or single multi-call.

#### I36. `purgeExpired` in Redis store is a no-op — `src/session-stores/redis.ts`

TTL is set per-key but the store doesn't expose a sweep. _Sessions set to expire via `pExpire(0)` are immediately deleted; sessions with longer TTL are not actively purged by the store._ **Fix:** Add a periodic sweep or document the lazy expiry model.

#### I37. Audit `tool.approval_decided` record omits `argumentsDigest` — `src/governance/audit.ts:199-211`

Unlike `policy.decision` and `tool.authorization_decided`, this branch only writes `{ name, reason? }`. _An approval grant cannot be correlated to the original tool arguments by audit readers._ **Fix:** Add `argumentsDigest`.

#### I38. `schemaSensitiveRedactor` fallback regex is case-sensitive — `src/governance/filters.ts:102-124`

The structured branch uses `key.toLowerCase()`. The fallback regex (lowercase, no `i` flag) only matches lowercase keys. _`Password=foo` in non-JSON content (logs, error messages) passes through unredacted._ **Fix:** Add `i` flag or build from the same `fieldNames` list.

#### I39. `defaultRedactionPatterns` misses JWT, PEM, and `Authorization: Bearer …` — `src/governance/filters.ts:33-41`

Patterns cover email, SSN, 13-19 digit PAN, and `key: value`/`key=value`. JWT (`eyJ….eyJ….`), `-----BEGIN PRIVATE KEY-----` blocks, `Bearer eyJ…`, GitHub PATs (`ghp_…`), AWS keys (`AKIA…`), and Slack tokens are not covered. **Fix:** Add patterns for the common header format and known token shapes.

#### I40. `eventPayload` emits raw `error.message` to log and bus — `src/events/subscribers.ts:138-143, 274-279`

Provider/HTTP errors routinely echo the request body, URL with query string, or file path with embedded credentials. **Fix:** Pipe `error.message` through `applyFilters` with a secret filter, or replace it with `{ name, code }` only.

#### I41. Telemetry: unbounded metric cardinality from caller-supplied `attrs` — `src/events/telemetry.ts:138-145`

`runDuration?.record(durationMs, attrs)` and `runs?.add(1, attrs)` accept whatever the run loop tags. If `run.id` is also stamped on the metric, the metric backend gains one time-series per run. **Fix:** Closed attribute whitelist on the bridge; split span attributes (rich) from metric attributes (low-cardinality whitelist).

#### I42. `forgeDataAuditLog.record` interpolates `JSON.stringify(entry.detail)` into a `sql` template — `src/governance/audit.ts:331-350`

Depends on forge's `sql` template parameterization behavior. _If forge inlines textually, a malicious `entry.detail` could break the statement._ **Fix:** Document the forge-version requirement; verify with installed forge version.

#### I43. Budget `scope` field declared but not honored — `src/resilience/budget.ts:10, 26-65`

`scope: "session"` is part of the public type but `evaluateBudget` takes a single `Usage` snapshot. _A host sets `scope: "session"` expecting per-session accumulation; the function silently behaves like `scope: "run"`._ **Fix:** Implement session-scoped accumulation, or remove the field.

#### I44. Audit: `error` events are not persisted — `src/governance/audit.ts:134-235`

A run that fails with a non-tool error (provider crash, timeout, max steps, budget exceeded) leaves no audit entry beyond the last tool call. **Fix:** Add `case "error"` and `case "run.finish"` branches.

#### I45. Approval `HumanInputGateway` accepts unbounded `answer` — `src/approval/human-input.ts:13-17, 71-122`

`resolve(requestId, answer)` puts any string into the model context. A compromised gateway (or a misbehaving host UI) can feed a multi-MB string. **Fix:** Add an `Answer` schema with a max-length validator (e.g. 16 KiB) on `askHumanTool`.

---
