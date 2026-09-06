import { PolybillError, type ProviderName } from "@polybill/core";

export async function hmacSha256(
  secret: string | Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    typeof secret === "string" ? new TextEncoder().encode(secret) : copy(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, copy(message)));
}

export async function verifyHmacHex(
  secret: string,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  const expected = toHex(await hmacSha256(secret, message));
  return constantTimeAsciiEqual(expected, signature.toLowerCase());
}

export async function verifyHmacBase64(
  secret: string | Uint8Array,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  const expected = toBase64(await hmacSha256(secret, message));
  return constantTimeAsciiEqual(expected, signature);
}

export function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new TypeError("Invalid base64 value");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function assertWebhookTimestamp(
  timestampSeconds: number,
  now: string,
  toleranceSeconds: number,
  provider: ProviderName,
): void {
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  )
    throw signatureError(provider);
  const age = Math.abs(Date.parse(now) / 1000 - timestampSeconds);
  if (age > toleranceSeconds) {
    throw new PolybillError("Webhook timestamp is outside the accepted tolerance", {
      code: "replay_rejected",
      operation: "webhook.verify",
      provider,
      retryable: false,
    });
  }
}

export function signatureError(provider: ProviderName): PolybillError {
  return new PolybillError("Webhook signature is invalid", {
    code: "signature_invalid",
    operation: "webhook.verify",
    provider,
    retryable: false,
  });
}

export async function rawDeliveryKey(provider: ProviderName, rawBody: Uint8Array): Promise<string> {
  return `${provider}:sha256:${toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy(rawBody))))}`;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function joinBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function constantTimeAsciiEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.byteLength ^ b.byteLength;
  const length = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (a[index % Math.max(a.byteLength, 1)] ?? 0) ^ (b[index % Math.max(b.byteLength, 1)] ?? 0);
  }
  return difference === 0;
}

function copy(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
