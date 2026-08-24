import { createWebSecretCrypto } from "@polybill/licensing";
import type { WorkerEnv } from "./bindings.js";

export function licensingCrypto(env: WorkerEnv) {
  return createWebSecretCrypto({
    digestKey: decodeKey(env.POLYBILL_DIGEST_KEY, "POLYBILL_DIGEST_KEY"),
    activeEncryptionKeyId: "worker-v1",
    encryptionKeys: {
      "worker-v1": decodeKey(env.POLYBILL_ENCRYPTION_KEY, "POLYBILL_ENCRYPTION_KEY"),
    },
  });
}

export async function redemptionShard(code: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeKey(value: string, name: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError(`${name} must be base64 encoded`);
  }
  if (decoded.byteLength !== 32) throw new TypeError(`${name} must decode to 32 bytes`);
  return decoded;
}
