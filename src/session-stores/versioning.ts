import type { SessionStore } from "../session/types";
import type { CloseableSessionStore, VersionedSessionStore } from "./types";

export const SESSION_STORE_SCHEMA_VERSION = 1;

export function isVersionedSessionStore(store: SessionStore): store is VersionedSessionStore {
  return typeof (store as { migrate?: unknown }).migrate === "function";
}

export function isCloseableSessionStore(store: SessionStore): store is CloseableSessionStore {
  return typeof (store as { close?: unknown }).close === "function";
}

export async function migrateSessionStore(store: SessionStore): Promise<void> {
  if (isVersionedSessionStore(store)) await store.migrate();
}
