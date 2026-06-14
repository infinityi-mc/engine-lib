import type { EngineContext } from "../runtime/types";
import type { Session } from "../session/types";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  TrustLevel,
} from "./types";

export const TRUST_METADATA_KEY = "engine:trust";

export interface TrustState {
  readonly schemaVersion: 1;
  readonly grantedLevel: TrustLevel;
  readonly updatedAt: string;
}

export interface TrustApprovalOptions {
  classify(
    call: { readonly name: string; readonly arguments: unknown },
    req: ApprovalRequest,
  ): TrustLevel;
  prompt(
    req: ApprovalRequest,
    ctx: EngineContext,
  ): ApprovalDecision | Promise<ApprovalDecision>;
  readonly maxAutoApprove?: TrustLevel;
  readonly allowElevatedAutoApprove?: boolean;
  readonly session?: Session;
}

const ORDER: Record<TrustLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const trustLocks = new Map<string, Promise<void>>();

async function withSessionTrustLock<T>(
  session: Session,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = trustLocks.get(session.id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  trustLocks.set(session.id, queued);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (trustLocks.get(session.id) === queued) trustLocks.delete(session.id);
  }
}

export function compareTrust(a: TrustLevel, b: TrustLevel): number {
  return ORDER[a] - ORDER[b];
}

function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function readTrustState(
  metadata: Record<string, unknown> | undefined,
): TrustState {
  const raw = metadata?.[TRUST_METADATA_KEY];
  if (typeof raw !== "object" || raw === null) {
    return {
      schemaVersion: 1,
      grantedLevel: "none",
      updatedAt: new Date(0).toISOString(),
    };
  }
  const level = (raw as { readonly grantedLevel?: unknown }).grantedLevel;
  return {
    schemaVersion: 1,
    grantedLevel: isTrustLevel(level) ? level : "none",
    updatedAt:
      typeof (raw as { readonly updatedAt?: unknown }).updatedAt === "string"
        ? (raw as { readonly updatedAt: string }).updatedAt
        : new Date(0).toISOString(),
  };
}

function maxTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return compareTrust(a, b) >= 0 ? a : b;
}

async function loadGrantedLevel(
  session: Session | undefined,
  fallback: TrustLevel,
): Promise<TrustLevel> {
  if (session === undefined) return fallback;
  return readTrustState(await session.getMetadata()).grantedLevel;
}

async function storeGrantedLevel(
  session: Session | undefined,
  current: TrustLevel,
  next: TrustLevel,
  setFallback: (level: TrustLevel) => void,
): Promise<void> {
  const raised = maxTrust(current, next);
  if (session === undefined) {
    setFallback(raised);
    return;
  }
  await withSessionTrustLock(session, async () => {
    const metadata = (await session.getMetadata()) ?? {};
    const existing = readTrustState(metadata).grantedLevel;
    const grantedLevel = maxTrust(existing, raised);
    await session.setMetadata({
      ...metadata,
      [TRUST_METADATA_KEY]: {
        schemaVersion: 1,
        grantedLevel,
        updatedAt: new Date().toISOString(),
      } satisfies TrustState,
    });
  });
}

export function trustApprovalPolicy(
  options: TrustApprovalOptions,
): ApprovalPolicy {
  let runGranted: TrustLevel = "none";
  const maxAutoApprove = options.maxAutoApprove ?? "low";

  return {
    async requiresApproval(req) {
      const required = options.classify(
        { name: req.name, arguments: req.arguments },
        req,
      );
      if (required === "none") return false;
      const granted = await loadGrantedLevel(options.session, runGranted);
      const withinGrant = compareTrust(required, granted) <= 0;
      const withinCeiling = compareTrust(required, maxAutoApprove) <= 0;
      return !(
        withinGrant &&
        (withinCeiling || options.allowElevatedAutoApprove)
      );
    },
    async decide(req, ctx) {
      const decision = await options.prompt(req, ctx);
      if (
        decision.approved &&
        decision.grant?.scope === "session" &&
        decision.remember !== false
      ) {
        const current = await loadGrantedLevel(options.session, runGranted);
        await storeGrantedLevel(
          options.session,
          current,
          decision.grant.level,
          (level) => {
            runGranted = level;
          },
        );
      }
      return decision;
    },
  };
}
