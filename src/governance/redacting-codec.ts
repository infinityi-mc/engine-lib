import type { Message } from "../messages/types";
import { jsonSessionStoreCodec } from "../session-stores/codec";
import type { SessionStoreCodec } from "../session-stores/types";
import { applyFilters, filterMessageText } from "./filters";
import type { ContentFilter } from "./filters";

export function redactingCodec(
  inner: SessionStoreCodec,
  filters: readonly ContentFilter[],
): SessionStoreCodec {
  const metadataCodec =
    inner.encodeMetadata !== undefined && inner.decodeMetadata !== undefined
      ? inner
      : jsonSessionStoreCodec;

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
      return metadataCodec.encodeMetadata!(metadata);
    },
    decodeMetadata(payload) {
      return metadataCodec.decodeMetadata!(payload);
    },
  };
}

export async function redactTextForPersistence(
  content: string,
  filters: readonly ContentFilter[],
): Promise<string> {
  return applyFilters(content, filters, { stage: "persistence" }, "redact");
}
