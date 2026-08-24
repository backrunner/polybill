import type { SecretCrypto } from "./ports.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function generateSecret(prefix: string, crypto: SecretCrypto): Promise<string> {
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(prefix))
    throw new TypeError("Secret prefix must be 2-8 uppercase characters");
  const payload = encodeBase32(crypto.randomBytes(20));
  const checksum = (await crypto.hash(`${prefix}${payload}`)).slice(0, 4).toUpperCase();
  return `${prefix}-${groups(payload)}-${checksum}`;
}

export async function normalizeSecret(
  value: string,
  expectedPrefix: string,
  crypto: SecretCrypto,
): Promise<string> {
  const normalized = value.replaceAll("-", "").trim().toUpperCase();
  const prefix = expectedPrefix.toUpperCase();
  if (!normalized.startsWith(prefix) || normalized.length !== prefix.length + 36)
    throw new TypeError("Invalid secret format");
  const payload = normalized.slice(prefix.length, -4);
  if (![...payload].every((character) => ALPHABET.includes(character)))
    throw new TypeError("Invalid secret alphabet");
  const checksum = normalized.slice(-4);
  const expected = (await crypto.hash(`${prefix}${payload}`)).slice(0, 4).toUpperCase();
  if (checksum !== expected) throw new TypeError("Invalid secret checksum");
  return normalized;
}

function groups(value: string): string {
  return value.match(/.{1,4}/g)?.join("-") ?? value;
}

function encodeBase32(value: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(buffer >>> bits) & 31] ?? "";
    }
  }
  if (bits > 0) output += ALPHABET[(buffer << (5 - bits)) & 31] ?? "";
  return output;
}
