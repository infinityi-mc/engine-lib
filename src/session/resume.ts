import type { Usage } from "../providers/types";
import type { SessionState } from "./types";

/** Reserved metadata key for engine-lib's typed resume record. */
export const RESUME_METADATA_KEY = "engine:resume" as const;

/** Latest resume metadata schema version this runtime understands. */
export const RESUME_SCHEMA_VERSION = 2 as const;

/** Typed metadata written by runAgent so hosts can triage and safely resume sessions. */
export interface SessionResumeInfo {
  readonly schemaVersion: number;
  readonly agentName: string;
  readonly model?: string;
  readonly provider?: string;
  readonly agentVersion?: string;
  readonly toolNames?: readonly string[];
  readonly lastActiveAt: string;
  readonly lastRunStatus: "completed" | "failed" | "interrupted";
  readonly totalUsage?: Usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  return (
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.totalTokens === "number"
  );
}

function isStatus(value: unknown): value is SessionResumeInfo["lastRunStatus"] {
  return value === "completed" || value === "failed" || value === "interrupted";
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function metadataOf(
  source: SessionState | Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (source === undefined) return undefined;
  const maybeState = source as Partial<SessionState>;
  if (typeof maybeState.id === "string" && Array.isArray(maybeState.messages)) {
    return maybeState.metadata;
  }
  return source as Record<string, unknown>;
}

/** Read the typed resume record from a session state or metadata object. */
export function readResumeInfo(
  source: SessionState | Record<string, unknown> | undefined,
): SessionResumeInfo | undefined {
  const metadata = metadataOf(source);
  const value = metadata?.[RESUME_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (typeof value.schemaVersion !== "number") return undefined;
  if (value.schemaVersion > RESUME_SCHEMA_VERSION) return undefined;
  if (typeof value.agentName !== "string") return undefined;
  if (typeof value.lastActiveAt !== "string") return undefined;
  if (!isStatus(value.lastRunStatus)) return undefined;
  if (value.model !== undefined && typeof value.model !== "string")
    return undefined;
  if (value.provider !== undefined && typeof value.provider !== "string")
    return undefined;
  if (
    value.agentVersion !== undefined &&
    typeof value.agentVersion !== "string"
  )
    return undefined;
  if (value.toolNames !== undefined && !isStringArray(value.toolNames))
    return undefined;
  if (value.totalUsage !== undefined && !isUsage(value.totalUsage))
    return undefined;

  return {
    schemaVersion: value.schemaVersion,
    agentName: value.agentName,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.agentVersion !== undefined
      ? { agentVersion: value.agentVersion }
      : {}),
    ...(value.toolNames !== undefined
      ? { toolNames: [...value.toolNames] }
      : {}),
    lastActiveAt: value.lastActiveAt,
    lastRunStatus: value.lastRunStatus,
    ...(value.totalUsage !== undefined ? { totalUsage: value.totalUsage } : {}),
  };
}

/** Merge a typed resume record into host metadata without clobbering host keys. */
export function withResumeInfo(
  metadata: Record<string, unknown> | undefined,
  info: SessionResumeInfo,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [RESUME_METADATA_KEY]: { ...info },
  };
}
