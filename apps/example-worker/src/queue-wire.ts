import type { InboxRecord } from "@polybill/webhooks";

export interface SerializedInboxRecord {
  readonly version: 1;
  readonly record: Omit<InboxRecord, "verified"> & {
    readonly verified: Omit<InboxRecord["verified"], "rawBody"> & {
      readonly rawBodyBase64: string;
    };
  };
}

export function serializeInboxRecord(record: InboxRecord): SerializedInboxRecord {
  const { rawBody, ...verified } = record.verified;
  return {
    version: 1,
    record: {
      ...record,
      verified: { ...verified, rawBodyBase64: encodeBase64(rawBody) },
    },
  };
}

export function deserializeInboxRecord(message: SerializedInboxRecord): InboxRecord {
  if (message.version !== 1) throw new TypeError("Unsupported webhook queue message version");
  const { rawBodyBase64, ...verified } = message.record.verified;
  return {
    ...message.record,
    verified: { ...verified, rawBody: decodeBase64(rawBodyBase64) },
  };
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
