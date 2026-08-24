import type { CheckoutSession, Price } from "@polybill/core";

export function decodePrice(value: string): Price {
  const parsed = parseStored(value, "catalog price");
  if (
    !record(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.skuId !== "string" ||
    typeof parsed.version !== "number" ||
    !record(parsed.model) ||
    typeof parsed.model.kind !== "string" ||
    (parsed.status !== "active" && parsed.status !== "retired")
  )
    throw new TypeError("Stored D1 catalog price is invalid");
  return parsed as unknown as Price;
}

export function decodeCheckout(value: string): CheckoutSession {
  const parsed = parseStored(value, "checkout snapshot");
  if (
    !record(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.orderId !== "string" ||
    !["open", "complete", "expired", "canceled"].includes(String(parsed.status))
  )
    throw new TypeError("Stored D1 checkout snapshot is invalid");
  return parsed as unknown as CheckoutSession;
}

export function parseStored(value: string | null, name: string): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`Stored D1 ${name} is invalid JSON`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
