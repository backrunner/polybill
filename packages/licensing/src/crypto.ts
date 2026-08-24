import type { SecretCrypto } from "./ports.js";

export interface WebSecretCryptoOptions {
  readonly digestKey: Uint8Array;
  readonly activeEncryptionKeyId: string;
  readonly encryptionKeys: Readonly<Record<string, Uint8Array>>;
  readonly crypto?: Crypto;
}

export function createWebSecretCrypto(options: WebSecretCryptoOptions): SecretCrypto {
  const crypto = options.crypto ?? globalThis.crypto;
  if (crypto === undefined) throw new Error("Web Crypto is unavailable in this runtime");
  if (options.digestKey.byteLength < 16)
    throw new TypeError("Digest key must contain at least 128 bits");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.activeEncryptionKeyId))
    throw new TypeError("Invalid encryption key ID");
  const active = options.encryptionKeys[options.activeEncryptionKeyId];
  if (active === undefined) throw new TypeError("Active encryption key is missing");
  for (const key of Object.values(options.encryptionKeys)) validateAesKey(key);

  return {
    randomBytes(length) {
      if (!Number.isSafeInteger(length) || length < 1)
        throw new RangeError("Invalid random byte length");
      return crypto.getRandomValues(new Uint8Array(length));
    },
    async digest(value) {
      const key = await crypto.subtle.importKey(
        "raw",
        copy(options.digestKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return toHex(
        new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
      );
    },
    async hash(value) {
      return toHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      );
    },
    async encrypt(value, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await importAes(crypto, active);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        key,
        new TextEncoder().encode(value),
      );
      return `v1.${options.activeEncryptionKeyId}.${toHex(iv)}.${toHex(new Uint8Array(encrypted))}`;
    },
    async decrypt(value, aad) {
      const parts = value.split(".");
      if (parts.length !== 4 || parts[0] !== "v1")
        throw new TypeError("Invalid encrypted secret envelope");
      const keyId = parts[1];
      const ivHex = parts[2];
      const cipherHex = parts[3];
      if (keyId === undefined || ivHex === undefined || cipherHex === undefined)
        throw new TypeError("Invalid encrypted secret envelope");
      const material = options.encryptionKeys[keyId];
      if (material === undefined) throw new Error("Encryption key is unavailable");
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromHex(ivHex), additionalData: new TextEncoder().encode(aad) },
        await importAes(crypto, material),
        fromHex(cipherHex),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    },
  };
}

async function importAes(crypto: Crypto, value: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", copy(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function copy(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function validateAesKey(value: Uint8Array): void {
  if (![16, 24, 32].includes(value.byteLength))
    throw new TypeError("AES key must contain 128, 192, or 256 bits");
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new TypeError("Invalid hexadecimal value");
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1)
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}
