# Changelog

## 2.0.0

- Breaking: `SessionStore` now requires `list()` and `setMetadata()`.
- Breaking: `SessionStore.append()` and `Session.append()` now resolve an
  `AppendResult`; returning `{}` is valid for custom stores with no compaction.
- Added typed resume metadata helpers: `RESUME_METADATA_KEY`, `readResumeInfo()`,
  and `withResumeInfo()`.
- Added checkpoint step persistence, dangling tool-call resume reconciliation,
  model compatibility policies, and session lifecycle events.
- Added `truncateToolAware()` and structure-aware summarization boundaries.
- Added opt-in expiry capability via `setExpiry()` and `purgeExpired()`.
- Added `summarizingCompactor()` for persisted pinned summary messages.

Migration notes:

1. Custom stores must implement `list(options?)`, `setMetadata(id, metadata)`,
   and return an `AppendResult` from `append()`.
2. SQL stores require `migrate()` to add `expires_at` plus listing/expiry
   indexes; the migration is additive and idempotent.
3. Redis clients used with listing or expiry must provide `scan` and
   `pExpire`/`pexpire`.
4. Resume reconciliation defaults on and model compatibility defaults to
   `"warn"`; set `resume: false` and `modelCompatibility: "ignore"` for legacy
   behavior.
