import type { Message } from "../messages/types";
import type { SessionStoreCodec } from "./types";

function decodeObject<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

/** Default JSON codec used by all built-in durable stores. */
export const jsonSessionStoreCodec: SessionStoreCodec = {
  encodeMessage(message: Message): string {
    return JSON.stringify(message);
  },

  decodeMessage(payload: string): Message {
    return decodeObject<Message>(payload);
  },

  encodeMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
    return metadata === undefined ? undefined : JSON.stringify(metadata);
  },

  decodeMetadata(payload: string | undefined): Readonly<Record<string, unknown>> | undefined {
    return payload === undefined ? undefined : decodeObject<Record<string, unknown>>(payload);
  },
};

export async function encodeMetadata(
  codec: SessionStoreCodec,
  metadata: Readonly<Record<string, unknown>> | undefined,
): Promise<string | undefined> {
  if (codec.encodeMetadata !== undefined) return codec.encodeMetadata(metadata);
  return jsonSessionStoreCodec.encodeMetadata!(metadata);
}

export async function decodeMetadata(
  codec: SessionStoreCodec,
  payload: string | null | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const value = payload ?? undefined;
  if (codec.decodeMetadata !== undefined) return codec.decodeMetadata(value);
  return jsonSessionStoreCodec.decodeMetadata!(value);
}

export async function encodeMessages(
  codec: SessionStoreCodec,
  messages: readonly Message[],
): Promise<string[]> {
  const encoded: string[] = [];
  for (const message of messages) encoded.push(await codec.encodeMessage(message));
  return encoded;
}

export async function decodeMessages(
  codec: SessionStoreCodec,
  payloads: readonly string[],
): Promise<Message[]> {
  const messages: Message[] = [];
  for (const payload of payloads) messages.push(await codec.decodeMessage(payload));
  return messages;
}
