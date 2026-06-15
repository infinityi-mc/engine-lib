/**
 * Session forking — copy a prefix of one session's history into a new,
 * independent session.
 *
 * Forking is the substrate for "try again" / A-B exploration: branch a
 * conversation at a point, then run each branch separately without replaying.
 * The copy is store-agnostic (it goes through the same `load`/`save`/`claimTenant`
 * contract every {@link SessionStore} implements), so it works for every backend.
 *
 * The fork point snaps **down to a turn boundary** (reusing the context layer's
 * {@link splitConversationTurns} grouping) so a fork can never split an assistant
 * tool-call message from its corresponding tool-result messages.
 *
 * @module
 */

import { splitConversationTurns } from "../context/window";
import type { Message } from "../messages/types";
import { createSession } from "./session";
import type { ForkOptions, Session, SessionState, SessionStore } from "./types";

export type { ForkOptions } from "./types";

/**
 * Snap a cut point down to the nearest turn boundary.
 *
 * Valid boundaries are the prefix sums of the turn-group lengths (always
 * including 0 and the full length). Returns the largest boundary `<= atIndex`,
 * guaranteeing the prefix `messages[0..boundary)` never ends mid-turn.
 */
export function snapForkIndex(
  messages: readonly Message[],
  atIndex: number,
): number {
  const clamped = Math.max(0, Math.min(atIndex, messages.length));
  if (clamped === 0 || clamped === messages.length) return clamped;
  const groups = splitConversationTurns(messages);
  let boundary = 0;
  for (const group of groups) {
    const next = boundary + group.messages.length;
    if (next > clamped) break;
    boundary = next;
  }
  return boundary;
}

function resolveForkMetadata(
  source: SessionState | undefined,
  option: ForkOptions["metadata"],
): Record<string, unknown> | undefined {
  if (option === false) return undefined;
  if (option !== undefined) return { ...option };
  return source?.metadata === undefined ? undefined : { ...source.metadata };
}

/**
 * Copy a prefix of `session`'s history into a new, independent {@link Session}.
 *
 * The source session is never modified; the fork inherits the source's
 * `tenantId` (a fork cannot cross tenants) and, by default, its metadata. Both
 * sessions are independent thereafter — appending to one does not affect the
 * other.
 */
export async function forkSession(
  session: Session,
  options: ForkOptions = {},
): Promise<Session> {
  const store: SessionStore = session.store;
  const targetId = options.id;
  if (targetId !== undefined) {
    const existingTarget = await store.load(targetId);
    if (existingTarget !== undefined) {
      throw new Error(`fork target session already exists: ${targetId}`);
    }
  }
  const source = await store.load(session.id);
  const sourceMessages = source?.messages ?? [];
  const cut = snapForkIndex(
    sourceMessages,
    options.atIndex ?? sourceMessages.length,
  );
  const messages = sourceMessages.slice(0, cut);
  const metadata = resolveForkMetadata(source, options.metadata);
  const tenantId = source?.tenantId ?? session.tenantId;

  const fork = createSession({
    ...(targetId !== undefined ? { id: targetId } : {}),
    store,
    ...(messages.length > 0 ? { messages } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
  // createSession seeds lazily on first access; force it so the fork is durably
  // present in the store before the handle is returned.
  await fork.messages();
  return fork;
}
