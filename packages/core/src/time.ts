import { unsafeBrand, type Brand } from "./brand.js";

export type IsoDateTime = Brand<string, "IsoDateTime">;

export function parseIsoDateTime(value: unknown): IsoDateTime {
  if (typeof value !== "string") throw new TypeError("Expected an RFC 3339 timestamp");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || !value.endsWith("Z")) {
    throw new TypeError("Expected an RFC 3339 UTC timestamp");
  }
  return unsafeBrand<string, "IsoDateTime">(new Date(epoch).toISOString());
}

export interface Clock {
  now(): IsoDateTime;
}
