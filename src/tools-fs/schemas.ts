import type { JsonSchema, Schema, SafeParseResult } from "../schema/types";
import { SchemaValidationError } from "../errors";
import type {
  ApplyPatchArgs,
  DiffStatusArgs,
  EditRangeArgs,
  EditReplaceArgs,
  FindFilesArgs,
  OpenWindowArgs,
  ReadArgs,
  RepoMapArgs,
  SearchSemanticArgs,
  SearchTextArgs,
  SymbolsArgs,
  WriteFileArgs,
} from "./types";

type Path = ReadonlyArray<string | number>;
interface RawJsonSchema {
  readonly type?: JsonSchema["type"];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, RawJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: RawJsonSchema;
  readonly enum?: ReadonlyArray<string | number>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly oneOf?: readonly RawJsonSchema[];
  readonly default?: unknown;
  readonly additionalProperties?: boolean | RawJsonSchema;
}

function issue(path: Path, message: string) {
  return { path: [...path], message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(node: RawJsonSchema, input: unknown, path: Path = []): ReturnType<typeof issue>[] {
  const issues: ReturnType<typeof issue>[] = [];

  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter((schema) => validate(schema, input, path).length === 0);
    if (matches.length !== 1) issues.push(issue(path, "expected exactly one matching schema"));
    return issues;
  }

  if (node.enum !== undefined) {
    if (!node.enum.includes(input as string | number)) {
      issues.push(issue(path, `expected one of ${JSON.stringify(node.enum)}`));
    }
    return issues;
  }

  switch (node.type) {
    case "string":
      if (typeof input !== "string") issues.push(issue(path, "expected string"));
      break;
    case "boolean":
      if (typeof input !== "boolean") issues.push(issue(path, "expected boolean"));
      break;
    case "integer":
      if (typeof input !== "number" || !Number.isInteger(input)) {
        issues.push(issue(path, "expected integer"));
      }
      break;
    case "number":
      if (typeof input !== "number" || Number.isNaN(input)) issues.push(issue(path, "expected number"));
      break;
    case "array":
      if (!Array.isArray(input)) {
        issues.push(issue(path, "expected array"));
        break;
      }
      if (node.items !== undefined) {
        input.forEach((value, index) => {
          issues.push(...validate(node.items as RawJsonSchema, value, [...path, index]));
        });
      }
      break;
    case "object": {
      if (!isPlainObject(input)) {
        issues.push(issue(path, "expected object"));
        break;
      }
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) {
        if (input[key] === undefined) issues.push(issue([...path, key], "required"));
      }
      for (const [key, prop] of Object.entries(properties)) {
        if (input[key] !== undefined) issues.push(...validate(prop as RawJsonSchema, input[key], [...path, key]));
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(input)) {
          if (!(key in properties)) issues.push(issue([...path, key], "unexpected property"));
        }
      } else if (typeof node.additionalProperties === "object") {
        for (const [key, value] of Object.entries(input)) {
          if (!(key in properties)) {
            issues.push(...validate(node.additionalProperties, value, [...path, key]));
          }
        }
      }
      break;
    }
    default:
      break;
  }

  if ((node.type === "integer" || node.type === "number") && typeof input === "number") {
    if (node.minimum !== undefined && input < node.minimum) {
      issues.push(issue(path, `expected >= ${node.minimum}`));
    }
    if (node.maximum !== undefined && input > node.maximum) {
      issues.push(issue(path, `expected <= ${node.maximum}`));
    }
  }

  return issues;
}

export function toolSchema<T>(jsonSchema: RawJsonSchema): Schema<T> {
  return {
    jsonSchema: jsonSchema as JsonSchema,
    safeParse(input: unknown): SafeParseResult<T> {
      const issues = validate(jsonSchema, input);
      if (issues.length === 0) return { success: true, data: input as T };
      return {
        success: false,
        error: new SchemaValidationError("schema validation failed", { issues }),
      };
    },
    parse(input: unknown): T {
      const result = this.safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
  };
}

const stringSchema = { type: "string" } as const;
const boolSchema = { type: "boolean" } as const;
const intSchema = (extra: Record<string, unknown> = {}) => ({ type: "integer", ...extra } as const);
const stringArray = { type: "array", items: stringSchema } as const;

export const SCHEMAS = {
  repoMap: toolSchema<RepoMapArgs>({
    type: "object",
    properties: {
      root: { ...stringSchema, default: "." },
      depth: intSchema({ minimum: 1, maximum: 6, default: 3 }),
      include_files: { ...boolSchema, default: true },
      include_symbols: { ...boolSchema, default: false },
      max_entries: intSchema({ default: 300 }),
      respect_gitignore: { ...boolSchema, default: true },
    },
    additionalProperties: false,
  }),
  findFiles: toolSchema<FindFilesArgs>({
    type: "object",
    properties: {
      query: stringSchema,
      mode: { type: "string", enum: ["auto", "exact", "glob", "fuzzy", "extension", "regex"], default: "auto" },
      root: { ...stringSchema, default: "." },
      include_hidden: { ...boolSchema, default: false },
      respect_gitignore: { ...boolSchema, default: true },
      max_results: intSchema({ default: 50 }),
    },
    required: ["query"],
    additionalProperties: false,
  }),
  searchText: toolSchema<SearchTextArgs>({
    type: "object",
    properties: {
      pattern: stringSchema,
      mode: { type: "string", enum: ["literal", "regex"], default: "literal" },
      root: { ...stringSchema, default: "." },
      include_globs: stringArray,
      exclude_globs: stringArray,
      case_sensitive: { ...boolSchema, default: false },
      context_lines: intSchema({ minimum: 0, maximum: 10, default: 2 }),
      max_results: intSchema({ default: 50 }),
      max_preview_chars: intSchema({ default: 12000 }),
      use_index: { ...boolSchema, default: true },
    },
    required: ["pattern"],
    additionalProperties: false,
  }),
  searchSemantic: toolSchema<SearchSemanticArgs>({
    type: "object",
    properties: {
      query: stringSchema,
      root: { ...stringSchema, default: "." },
      include_globs: stringArray,
      exclude_globs: stringArray,
      granularity: { type: "string", enum: ["file", "chunk", "symbol"], default: "chunk" },
      max_results: intSchema({ default: 20 }),
      max_preview_chars: intSchema({ default: 12000 }),
    },
    required: ["query"],
    additionalProperties: false,
  }),
  symbols: toolSchema<SymbolsArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      recursive: { ...boolSchema, default: false },
      symbol_kinds: {
        type: "array",
        items: {
          type: "string",
          enum: ["class", "function", "method", "interface", "type", "variable", "import", "export"],
        },
      },
      max_results: intSchema({ default: 200 }),
    },
    required: ["path"],
    additionalProperties: false,
  }),
  read: toolSchema<ReadArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      start_line: intSchema({ minimum: 1 }),
      end_line: intSchema({ minimum: 1 }),
      symbol: stringSchema,
      max_bytes: intSchema({ default: 20000 }),
      include_line_numbers: { ...boolSchema, default: true },
      collapse_imports: { ...boolSchema, default: false },
      collapse_comments: { ...boolSchema, default: false },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  openWindow: toolSchema<OpenWindowArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      anchor: { oneOf: [intSchema(), stringSchema] },
      window_lines: intSchema({ minimum: 20, maximum: 200, default: 100 }),
      direction: { type: "string", enum: ["center", "next", "prev"], default: "center" },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  editReplace: toolSchema<EditReplaceArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      old_text: stringSchema,
      new_text: stringSchema,
      occurrence: intSchema({ minimum: 1, default: 1 }),
      expected_file_version: stringSchema,
      validate: validationSchema(),
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  }),
  editRange: toolSchema<EditRangeArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      start_line: intSchema({ minimum: 1 }),
      end_line: intSchema({ minimum: 1 }),
      new_text: stringSchema,
      expected_file_version: stringSchema,
      validate: validationSchema(),
    },
    required: ["path", "start_line", "end_line", "new_text", "expected_file_version"],
    additionalProperties: false,
  }),
  applyPatch: toolSchema<ApplyPatchArgs>({
    type: "object",
    properties: {
      patch: stringSchema,
      root: { ...stringSchema, default: "." },
      dry_run: { ...boolSchema, default: false },
      expected_versions: { type: "object", additionalProperties: stringSchema },
      validate: validationSchema(),
    },
    required: ["patch"],
    additionalProperties: false,
  }),
  writeFile: toolSchema<WriteFileArgs>({
    type: "object",
    properties: {
      path: stringSchema,
      content: stringSchema,
      mode: { type: "string", enum: ["create_only", "overwrite", "append"], default: "create_only" },
      expected_file_version: stringSchema,
      create_dirs: { ...boolSchema, default: true },
    },
    required: ["path", "content"],
    additionalProperties: false,
  }),
  diffStatus: toolSchema<DiffStatusArgs>({
    type: "object",
    properties: {
      paths: stringArray,
      include_diff: { ...boolSchema, default: true },
      max_diff_chars: intSchema({ default: 20000 }),
      context_lines: intSchema({ default: 3 }),
    },
    additionalProperties: false,
  }),
} as const;

function validationSchema(): RawJsonSchema {
  return {
    type: "object",
    properties: {
      syntax: { ...boolSchema, default: true },
      format: { ...boolSchema, default: false },
      tests: stringArray,
    },
    additionalProperties: false,
  };
}
