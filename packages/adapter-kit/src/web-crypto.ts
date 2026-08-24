import type { CryptoPort } from "./context.js";

export function createWebCryptoPort(crypto: Crypto = globalThis.crypto): CryptoPort {
  if (crypto === undefined) throw new Error("Web Crypto is unavailable in this runtime");
  return {
    async sha256(value) {
      const bytes = Uint8Array.from(value);
      const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
      return toHex(new Uint8Array(digest));
    },
    randomBytes(length) {
      if (!Number.isSafeInteger(length) || length < 1) {
        throw new RangeError("Invalid random byte length");
      }
      return crypto.getRandomValues(new Uint8Array(length));
    },
    timingSafeEqual(left, right) {
      if (left.byteLength !== right.byteLength) return false;
      let difference = 0;
      for (let index = 0; index < left.byteLength; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      }
      return difference === 0;
    },
  };
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
