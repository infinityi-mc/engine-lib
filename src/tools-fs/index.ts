/**
 * `@infinityi/engine-lib/tools-fs` — optional, policy-gated filesystem and
 * workspace tools for coding agents and local document agents.
 *
 * The core library remains tool-agnostic. This subpath exports a single
 * {@link filesystemTools} factory that binds prebuilt tool definitions to an
 * explicit allowed-root policy.
 *
 * @example
 * ```ts
 * import { filesystemTools } from "@infinityi/engine-lib/tools-fs";
 *
 * const fs = filesystemTools({ allowedRoots: [process.cwd()] });
 * ```
 *
 * @module
 */

export { filesystemTools } from "./define";

export type {
  ApplyPatchArgs,
  DiffStatusArgs,
  EditRangeArgs,
  EditReplaceArgs,
  FilesystemTools,
  FilesystemToolsConfig,
  FindFilesArgs,
  OpenWindowArgs,
  ReadArgs,
  RepoMapArgs,
  SearchSemanticArgs,
  SearchTextArgs,
  SymbolInfo,
  SymbolKind,
  SymbolsArgs,
  ValidationCommandRequest,
  ValidationCommandResult,
  ValidationOptions,
  WriteFileArgs,
} from "./types";
