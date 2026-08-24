import { PolybillError, money, type Money, type PriceModel } from "@polybill/core";
import type { CreateCheckoutResult } from "./checkout.js";
import type { ProviderCheckoutCommand } from "@polybill/adapter-kit";
import type { CheckoutId, OrderId, PaymentId } from "@polybill/core";

export function fixedUnitAmount(model: PriceModel): Money {
  if (model.kind === "free") return money("0", model.currency);
  if (model.kind === "one_time" || model.kind === "recurring" || model.kind === "seat") {
    return model.unit;
  }
  throw invalidCheckout(`Price model ${model.kind} requires an explicit checkout strategy`);
}

export function validatedRedirectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidCheckout("Checkout redirect URLs must be absolute HTTPS URLs");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.href.length > 2048
  ) {
    throw invalidCheckout("Checkout redirect URLs must be safe HTTPS URLs");
  }
  return url.href;
}

export function invalidCheckout(message: string): PolybillError {
  return new PolybillError(message, {
    code: "invalid_request",
    operation: "checkout.create",
    retryable: false,
  });
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function parseStoredCheckoutResult(value: unknown): CreateCheckoutResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("checkout" in value) ||
    !("order" in value) ||
    !("payment" in value) ||
    !("provider" in value) ||
    !("warnings" in value)
  ) {
    throw new PolybillError("Stored idempotency result is invalid", {
      code: "provider_response_invalid",
      operation: "checkout.idempotency_replay",
      retryable: false,
    });
  }
  return value as unknown as CreateCheckoutResult;
}

export interface StoredPreparedCheckout {
  readonly orderId: OrderId;
  readonly checkoutId: CheckoutId;
  readonly paymentId: PaymentId;
  readonly lines: ProviderCheckoutCommand["lines"];
  readonly providerCommand: ProviderCheckoutCommand;
}

export function parseStoredPreparedCheckout(value: unknown): StoredPreparedCheckout {
  if (
    typeof value !== "object" ||
    value === null ||
    !("orderId" in value) ||
    !("checkoutId" in value) ||
    !("paymentId" in value) ||
    !("lines" in value) ||
    !("providerCommand" in value)
  ) {
    throw new PolybillError("Stored recovery context is invalid", {
      code: "provider_response_invalid",
      operation: "checkout.recover",
      retryable: false,
    });
  }
  return value as unknown as StoredPreparedCheckout;
}
