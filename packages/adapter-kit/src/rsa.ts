import { decodeBase64 } from "./signatures.js";

const RSA_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const RSA_ALGORITHM_IDENTIFIER = decodeBase64("MA0GCSqGSIb3DQEBAQUA");

export async function signRsaSha256(privateKeyPem: string, message: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(privateKeyPem),
    RSA_ALGORITHM,
    false,
    ["sign"],
  );
  assertStrongRsa(key);
  return encodeBase64(
    new Uint8Array(await globalThis.crypto.subtle.sign(RSA_ALGORITHM.name, key, copy(message))),
  );
}

export async function verifyRsaSha256(
  publicKeyPem: string,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      publicKeyDer(publicKeyPem),
      RSA_ALGORITHM,
      false,
      ["verify"],
    );
    assertStrongRsa(key);
    return globalThis.crypto.subtle.verify(
      RSA_ALGORITHM.name,
      key,
      copy(decodeBase64(signature)),
      copy(message),
    );
  } catch {
    return false;
  }
}

export async function sha256Base64(value: Uint8Array): Promise<string> {
  return encodeBase64(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy(value))),
  );
}

function privateKeyDer(pem: string): ArrayBuffer {
  const normalized = pem.replaceAll("\\n", "\n").trim();
  const der = pemBytes(normalized);
  if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
    return copy(sequence(integerZero(), RSA_ALGORITHM_IDENTIFIER, octetString(der)));
  }
  if (!normalized.includes("BEGIN PRIVATE KEY") && normalized.includes("BEGIN"))
    throw new TypeError("Expected an RSA private key");
  return copy(der);
}

function publicKeyDer(pem: string): ArrayBuffer {
  const normalized = pem.replaceAll("\\n", "\n").trim();
  const der = pemBytes(normalized);
  if (normalized.includes("BEGIN RSA PUBLIC KEY"))
    return copy(sequence(RSA_ALGORITHM_IDENTIFIER, bitString(der)));
  if (!normalized.includes("BEGIN PUBLIC KEY") && normalized.includes("BEGIN"))
    throw new TypeError("Expected an RSA public key");
  return copy(der);
}

function pemBytes(value: string): Uint8Array {
  if (value.length > 32_768) throw new TypeError("PEM key exceeds the size limit");
  const base64 = value.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, "");
  if (base64.length === 0) throw new TypeError("PEM key is empty");
  return decodeBase64(base64);
}

function assertStrongRsa(key: CryptoKey): void {
  const algorithm = key.algorithm;
  if (
    !("modulusLength" in algorithm) ||
    typeof algorithm.modulusLength !== "number" ||
    algorithm.modulusLength < 2048
  )
    throw new TypeError("RSA keys must have at least 2048 bits");
}

function sequence(...values: readonly Uint8Array[]): Uint8Array {
  return tagged(0x30, concat(values));
}
function octetString(value: Uint8Array): Uint8Array {
  return tagged(0x04, value);
}
function bitString(value: Uint8Array): Uint8Array {
  return tagged(0x03, concat([new Uint8Array([0]), value]));
}
function integerZero(): Uint8Array {
  return new Uint8Array([0x02, 0x01, 0x00]);
}

function tagged(tag: number, value: Uint8Array): Uint8Array {
  return concat([new Uint8Array([tag]), lengthBytes(value.byteLength), value]);
}
function lengthBytes(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const values: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    values.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | values.length, ...values]);
}
function concat(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
function copy(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
