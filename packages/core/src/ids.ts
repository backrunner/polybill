import { unsafeBrand, type Brand } from "./brand.js";

export type TenantId = Brand<string, "TenantId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type ProductId = Brand<string, "ProductId">;
export type SkuId = Brand<string, "SkuId">;
export type PriceId = Brand<string, "PriceId">;
export type CustomerId = Brand<string, "CustomerId">;
export type CheckoutId = Brand<string, "CheckoutId">;
export type OrderId = Brand<string, "OrderId">;
export type PaymentId = Brand<string, "PaymentId">;
export type RefundId = Brand<string, "RefundId">;
export type DiscountId = Brand<string, "DiscountId">;
export type DiscountRedemptionId = Brand<string, "DiscountRedemptionId">;
export type SubscriptionId = Brand<string, "SubscriptionId">;
export type MeterId = Brand<string, "MeterId">;
export type UsageEventId = Brand<string, "UsageEventId">;
export type CreditTransactionId = Brand<string, "CreditTransactionId">;
export type EventId = Brand<string, "EventId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type RequestId = Brand<string, "RequestId">;
export type SettlementQuoteId = Brand<string, "SettlementQuoteId">;
export type EntitlementPolicyId = Brand<string, "EntitlementPolicyId">;
export type EntitlementGrantId = Brand<string, "EntitlementGrantId">;
export type LicenseId = Brand<string, "LicenseId">;
export type LicenseInstanceId = Brand<string, "LicenseInstanceId">;
export type VoucherBatchId = Brand<string, "VoucherBatchId">;
export type VoucherId = Brand<string, "VoucherId">;
export type RedemptionId = Brand<string, "RedemptionId">;

const ID_PATTERN = /^[a-z][a-z0-9_]{1,31}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const IDEMPOTENCY_PATTERN = /^[\x21-\x7e]{8,255}$/;

export function parseId<Name extends string>(value: unknown, prefix: string): Brand<string, Name> {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new TypeError(`Expected a valid ${prefix} identifier`);
  }
  return unsafeBrand<string, Name>(value);
}

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new TypeError("Expected an 8-255 character printable idempotency key");
  }
  return unsafeBrand<string, "IdempotencyKey">(value);
}
