import { PolybillError, type ProviderName } from "@polybill/core";
import type { ProviderSubscriptionItem } from "./resource-ports.js";

export function assertSubscriptionIdentity(
  actual: unknown,
  expected: string,
  provider: ProviderName,
): void {
  if (actual !== expected || expected.length === 0)
    throw new PolybillError("Provider returned a different subscription", {
      code: "provider_response_invalid",
      operation: `${provider}.subscription.read`,
      provider,
      retryable: false,
    });
}

export function subscriptionUnsupported(provider: ProviderName, message: string): PolybillError {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: `${provider}.subscription.mutate`,
    provider,
    retryable: false,
  });
}

export function positiveSubscriptionQuantity(value: unknown, provider: ProviderName): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new PolybillError("Invalid subscription quantity", {
      code: "provider_response_invalid",
      operation: `${provider}.subscription.decode`,
      provider,
      retryable: false,
    });
  return value;
}

export function singleSubscriptionItem(
  items: readonly ProviderSubscriptionItem[],
  provider: ProviderName,
): ProviderSubscriptionItem {
  const item = items[0];
  if (items.length !== 1 || item === undefined)
    throw subscriptionUnsupported(
      provider,
      "This subscription requires exactly one mapped product",
    );
  assertProviderSubscriptionItems(items);
  return item;
}

export function assertProviderSubscriptionItems(items: readonly ProviderSubscriptionItem[]): void {
  if (
    items.length === 0 ||
    new Set(items.map((item) => item.externalPriceId)).size !== items.length ||
    items.some(
      (item) =>
        item.externalPriceId.length === 0 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1,
    )
  )
    throw new TypeError("Invalid subscription items");
}
