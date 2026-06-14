import type { Message } from "../messages/types";
import { jsonSessionStoreCodec } from "../session-stores/codec";
import type { SessionStoreCodec } from "../session-stores/types";
import { applyFilters, filterMessageText } from "./filters";
import type { ContentFilter } from "./filters";

export function redactingCodec(
  inner: SessionStoreCodec,
  filters: readonly ContentFilter[],
): SessionStoreCodec {
  return {
    async encodeMessage(message: Message): Promise<string> {
      const filtered = await filterMessageText(
        message,
        filters,
        { stage: "persistence" },
        "redact",
      );
      return inner.encodeMessage(filtered);
    },
    decodeMessage(payload: string) {
      return inner.decodeMessage(payload);
    },
    async encodeMetadata(metadata) {
      if (inner.encodeMetadata !== undefined)
        return inner.encodeMetadata(metadata);
      return jsonSessionStoreCodec.encodeMetadata!(metadata);
    },
    decodeMetadata(payload) {
      if (inner.decodeMetadata !== undefined)
        return inner.decodeMetadata(payload);
      return jsonSessionStoreCodec.decodeMetadata!(payload);
    },
  };
}

export async function redactTextForPersistence(
  content: string,
  filters: readonly ContentFilter[],
): Promise<string> {
  return applyFilters(content, filters, { stage: "persistence" }, "redact");
}
