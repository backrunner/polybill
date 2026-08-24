import type { IdGenerator, Logger } from "@polybill/application";
import { parseIsoDateTime, type Clock } from "@polybill/core";
import type { CryptoPort } from "@polybill/adapter-kit";

export class SecureIdGenerator implements IdGenerator {
  readonly #crypto: CryptoPort;

  constructor(crypto: CryptoPort) {
    this.#crypto = crypto;
  }

  next(prefix: string): string {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(prefix)) {
      throw new TypeError("ID prefix must contain lowercase letters, digits, or underscores");
    }
    const suffix = Array.from(this.#crypto.randomBytes(16), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${prefix}_${suffix}`;
  }
}

export const systemClock: Clock = {
  now: () => parseIsoDateTime(new Date().toISOString()),
};

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
