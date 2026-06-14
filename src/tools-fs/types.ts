import type { ToolContext, ToolDefinition } from "../tools/types";
import type { PolicyEngine } from "../governance/policy";

export interface ValidationCommandResult {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ValidationCommandRequest {
  readonly cwd: string;
  readonly changedFiles: readonly string[];
  readonly ctx: ToolContext;
}

export interface FilesystemToolsConfig {
  /** Absolute directories that every filesystem operation must remain within. */
  readonly allowedRoots: readonly string[];
  /** Default workspace root. Relative paths resolve from here. Defaults to the first allowed root. */
  readonly defaultRoot?: string;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxEntries?: number;
  readonly maxResults?: number;
  /** Optional unified policy engine for filesystem operations. */
  readonly policy?: PolicyEngine;
  /**
   * Optional host hook for validation commands requested by edit tools.
   * When omitted, requested commands are reported as skipped rather than run.
   */
  readonly runValidationCommand?: (
    command: string,
    request: ValidationCommandRequest,
  ) => ValidationCommandResult | Promise<ValidationCommandResult>;
}

export interface ValidationOptions {
  readonly syntax?: boolean;
  readonly format?: boolean;
  readonly tests?: readonly string[];
}

export interface RepoMapArgs {
  readonly root?: string;
  readonly depth?: number;
  readonly include_files?: boolean;
  readonly include_symbols?: boolean;
  readonly max_entries?: number;
  readonly respect_gitignore?: boolean;
}

export interface FindFilesArgs {
  readonly query: string;
  readonly mode?: "auto" | "exact" | "glob" | "fuzzy" | "extension" | "regex";
  readonly root?: string;
  readonly include_hidden?: boolean;
  readonly respect_gitignore?: boolean;
  readonly max_results?: number;
}

export interface SearchTextArgs {
  readonly pattern: string;
  readonly mode?: "literal" | "regex";
  readonly root?: string;
  readonly include_globs?: readonly string[];
  readonly exclude_globs?: readonly string[];
  readonly case_sensitive?: boolean;
  readonly context_lines?: number;
  readonly max_results?: number;
  readonly max_preview_chars?: number;
  readonly use_index?: boolean;
}

export interface SearchSemanticArgs {
  readonly query: string;
  readonly root?: string;
  readonly include_globs?: readonly string[];
  readonly exclude_globs?: readonly string[];
  readonly granularity?: "file" | "chunk" | "symbol";
  readonly max_results?: number;
  readonly max_preview_chars?: number;
}

export interface SymbolsArgs {
  readonly path: string;
  readonly recursive?: boolean;
  readonly symbol_kinds?: readonly SymbolKind[];
  readonly max_results?: number;
}

export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "import"
  | "export";

export interface ReadArgs {
  readonly path: string;
  readonly start_line?: number;
  readonly end_line?: number;
  readonly symbol?: string;
  readonly max_bytes?: number;
  readonly include_line_numbers?: boolean;
  readonly collapse_imports?: boolean;
  readonly collapse_comments?: boolean;
}

export interface OpenWindowArgs {
  readonly path: string;
  readonly anchor?: number | string;
  readonly window_lines?: number;
  readonly direction?: "center" | "next" | "prev";
}

export interface EditReplaceArgs {
  readonly path: string;
  readonly old_text: string;
  readonly new_text: string;
  readonly occurrence?: number;
  readonly expected_file_version?: string;
  readonly validate?: ValidationOptions;
}

export interface EditRangeArgs {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly new_text: string;
  readonly expected_file_version: string;
  readonly validate?: ValidationOptions;
}

export interface ApplyPatchArgs {
  readonly patch: string;
  readonly root?: string;
  readonly dry_run?: boolean;
  readonly expected_versions?: Readonly<Record<string, string>>;
  readonly validate?: ValidationOptions;
}

export interface WriteFileArgs {
  readonly path: string;
  readonly content: string;
  readonly mode?: "create_only" | "overwrite" | "append";
  readonly expected_file_version?: string;
  readonly create_dirs?: boolean;
}

export interface DiffStatusArgs {
  readonly paths?: readonly string[];
  readonly include_diff?: boolean;
  readonly max_diff_chars?: number;
  readonly context_lines?: number;
}

export interface SymbolInfo {
  readonly path: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature?: string;
}

export interface FilesystemTools {
  readonly repoMap: ToolDefinition<RepoMapArgs>;
  readonly findFiles: ToolDefinition<FindFilesArgs>;
  readonly searchText: ToolDefinition<SearchTextArgs>;
  readonly searchSemantic: ToolDefinition<SearchSemanticArgs>;
  readonly symbols: ToolDefinition<SymbolsArgs>;
  readonly read: ToolDefinition<ReadArgs>;
  readonly openWindow: ToolDefinition<OpenWindowArgs>;
  readonly editReplace: ToolDefinition<EditReplaceArgs>;
  readonly editRange: ToolDefinition<EditRangeArgs>;
  readonly applyPatch: ToolDefinition<ApplyPatchArgs>;
  readonly writeFile: ToolDefinition<WriteFileArgs>;
  readonly diffStatus: ToolDefinition<DiffStatusArgs>;
}
