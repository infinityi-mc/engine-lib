/**
 * Typed error taxonomy for `@infinityi/engine-lib`.
 *
 * Every error the library throws is a subclass of {@link AgentError},
 * so consumers can branch with a single `instanceof AgentError` check
 * or narrow to a specific category.
 *
 * The full hierarchy is defined up-front so later phases import stable
 * symbols; only {@link SchemaValidationError} and
 * {@link ToolValidationError} are thrown by Phase-1 code.
 *
 * @module
 */

import type { Usage } from "./providers/types";

/** Structured validation issue attached to {@link SchemaValidationError}. */
export interface SchemaIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/**
 * Base class for every error thrown by `@infinityi/engine-lib`.
 * `instanceof AgentError` catches the entire family.
 */
export class AgentError extends Error {
  /**
   * Token usage accumulated before the run failed, when known. The run loop
   * stamps this onto the error it throws so a failed `runAgent` (or a failed
   * sub-agent invoked via `asTool`) still surfaces the tokens it consumed
   * rather than silently dropping them.
   */
  usage?: Usage;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
  }
}

/** A provider / LLM call failed (HTTP, protocol, refusal). */
export class ProviderError extends AgentError {
  readonly provider?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { provider?: string },
  ) {
    super(message, options);
    this.name = "ProviderError";
    if (options?.provider !== undefined) this.provider = options.provider;
  }
}

/** A tool's `execute` function threw (as opposed to returning an error result). */
export class ToolError extends AgentError {
  readonly toolName?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { toolName?: string },
  ) {
    super(message, options);
    this.name = "ToolError";
    if (options?.toolName !== undefined) this.toolName = options.toolName;
  }
}

/** Input failed schema validation. Carries machine-readable {@link SchemaIssue}s. */
export class SchemaValidationError extends AgentError {
  readonly issues: ReadonlyArray<SchemaIssue>;

  constructor(
    message: string,
    options: ErrorOptions & { issues: SchemaIssue[] },
  ) {
    super(message, options);
    this.name = "SchemaValidationError";
    this.issues = options.issues;
  }
}

/** Tool-call arguments from the model failed the tool's parameter schema. */
export class ToolValidationError extends SchemaValidationError {
  readonly toolName?: string;

  constructor(
    message: string,
    options: ErrorOptions & { toolName?: string; issues: SchemaIssue[] },
  ) {
    super(message, options);
    this.name = "ToolValidationError";
    if (options?.toolName !== undefined) this.toolName = options.toolName;
  }
}

/** The run loop / execution failed for a non-provider, non-tool reason. */
export class ExecutionError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionError";
  }
}

/** The model exceeded the configured max step / turn budget. */
export class MaxStepsExceededError extends ExecutionError {
  readonly steps?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { steps?: number },
  ) {
    super(message, options);
    this.name = "MaxStepsExceededError";
    if (options?.steps !== undefined) this.steps = options.steps;
  }
}

/** The run exceeded the configured maximum number of agent handoffs. */
export class MaxHandoffsExceededError extends ExecutionError {
  readonly handoffs?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { handoffs?: number },
  ) {
    super(message, options);
    this.name = "MaxHandoffsExceededError";
    if (options?.handoffs !== undefined) this.handoffs = options.handoffs;
  }
}

/** The run was aborted via `AbortSignal`. */
export class CancelledError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CancelledError";
  }
}

/** History cannot be reduced to fit the model context window. */
export class ContextWindowError extends AgentError {
  readonly tokens?: number;
  readonly limit?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { tokens?: number; limit?: number },
  ) {
    super(message, options);
    this.name = "ContextWindowError";
    if (options?.tokens !== undefined) this.tokens = options.tokens;
    if (options?.limit !== undefined) this.limit = options.limit;
  }
}

/**
 * The optional `tools-shell` module was misconfigured (e.g. an `allowedCwds`
 * entry that is not an absolute path). Thrown for host-side configuration
 * faults at factory-build time — policy *denials* of a model's command are not
 * errors; those return `{ ok: false, error }` from the tool so the model can
 * recover.
 */
export class ShellPolicyError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShellPolicyError";
  }
}

/**
 * The optional `tools-fs` module was misconfigured (for example, missing
 * absolute `allowedRoots`). Per-call filesystem denials are returned as tool
 * failures so the model can recover.
 */
export class FilesystemPolicyError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesystemPolicyError";
  }
}
