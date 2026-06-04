/**
 * Recursive validator backing every {@link Schema}.
 *
 * Validation is driven entirely by a {@link JsonSchema} node so that the
 * same logic covers both the built-in `s` builder and externally-supplied
 * schemas adapted via `asSchema`. It collects *all* issues (rather than
 * failing on the first) so callers get a complete picture.
 *
 * @module
 */

import type { SchemaIssue } from "../errors";
import type { JsonSchema } from "./types";

type Path = ReadonlyArray<string | number>;

function issue(path: Path, message: string): SchemaIssue {
  return { path: [...path], message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validate `input` against a {@link JsonSchema} node, accumulating issues.
 * Returns an empty array when `input` is valid.
 */
export function validateJsonSchema(
  node: JsonSchema,
  input: unknown,
  path: Path = [],
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  if (node.enum !== undefined) {
    if (!node.enum.includes(input as string | number)) {
      issues.push(
        issue(path, `expected one of ${JSON.stringify(node.enum)}`),
      );
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
    case "null":
      if (input !== null) issues.push(issue(path, "expected null"));
      break;
    case "number":
      if (typeof input !== "number" || Number.isNaN(input)) {
        issues.push(issue(path, "expected number"));
      }
      break;
    case "integer":
      if (typeof input !== "number" || !Number.isInteger(input)) {
        issues.push(issue(path, "expected integer"));
      }
      break;
    case "array": {
      if (!Array.isArray(input)) {
        issues.push(issue(path, "expected array"));
        break;
      }
      if (node.items !== undefined) {
        input.forEach((element, index) => {
          issues.push(...validateJsonSchema(node.items as JsonSchema, element, [...path, index]));
        });
      }
      break;
    }
    case "object": {
      if (!isPlainObject(input)) {
        issues.push(issue(path, "expected object"));
        break;
      }
      const properties = node.properties ?? {};
      const required = node.required ?? [];
      for (const key of required) {
        if (input[key] === undefined) {
          issues.push(issue([...path, key], "required"));
        }
      }
      for (const [key, propSchema] of Object.entries(properties)) {
        const value = input[key];
        // Absent / undefined optional properties are skipped; required ones
        // were already flagged above.
        if (value === undefined) continue;
        issues.push(...validateJsonSchema(propSchema, value, [...path, key]));
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(input)) {
          if (!(key in properties)) {
            issues.push(issue([...path, key], "unexpected property"));
          }
        }
      }
      break;
    }
    default:
      // No `type` constraint → accept anything.
      break;
  }

  return issues;
}
