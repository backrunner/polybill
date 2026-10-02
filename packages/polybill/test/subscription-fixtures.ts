import { createWebCryptoPort, type ProviderContext } from "@polybill/adapter-kit";
import { parseId, parseIdempotencyKey, parseIsoDateTime, type ProviderName } from "@polybill/core";
import { VirtualClock } from "@polybill/testing";

export const now = "2026-10-02T00:00:00.000Z";
export const end = "2026-11-02T00:00:00.000Z";
export const later = "2026-12-02T00:00:00.000Z";

export function subscriptionContext(
  provider: ProviderName,
  fetch: typeof globalThis.fetch,
): ProviderContext {
  const tenantId = parseId<"TenantId">("ten_subcontracts", "ten");
  return {
    tenantId,
    connection: {
      tenantId,
      id: parseId<"ConnectionId">("conn_subcontracts", "conn"),
      provider,
      environment: "test",
    },
    credentials: {
      apiKey:
        provider === "stripe"
          ? "sk_test_contract"
          : provider === "paddle"
            ? "pdl_sdbx_contract"
            : "contract",
      accessToken: "contract",
    },
    requestId: parseId<"RequestId">("req_subcontracts", "req"),
    idempotencyKey: parseIdempotencyKey("subscription-contracts"),
    deadline: parseIsoDateTime("2026-10-02T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock(now),
  };
}

export const polarSubscription = {
  id: "sub_fixture",
  customer_id: "cus_fixture",
  product_id: "prod_fixture",
  seats: 2,
  units: null,
  status: "active",
  current_period_start: now,
  current_period_end: end,
  cancel_at_period_end: false,
  pause_at_period_end: false,
  resumes_at: null,
  pending_update: null,
  trial_end: null,
};
export const dodoSubscription = {
  subscription_id: "sub_fixture",
  customer: { customer_id: "cus_fixture" },
  product_id: "prod_fixture",
  quantity: 2,
  status: "active",
  previous_billing_date: now,
  next_billing_date: end,
  cancel_at_next_billing_date: false,
  scheduled_change: null,
  addons: [{ addon_id: "addon_fixture", quantity: 3, name: "extra read-only detail" }],
};
export const creemSubscription = {
  id: "sub_fixture",
  customer: "cus_fixture",
  product: "prod_fixture",
  status: "active",
  items: [{ id: "sitem_fixture", product_id: "prod_fixture", price_id: "price_fixture", units: 2 }],
  current_period_start_date: now,
  current_period_end_date: end,
};
export const paddleSubscription = {
  id: "sub_fixture",
  customer_id: "cus_fixture",
  status: "active",
  collection_mode: "automatic",
  items: [{ price: { id: "price_fixture" }, quantity: 2 }],
  current_billing_period: { starts_at: now, ends_at: end },
  scheduled_change: null,
  next_billed_at: end,
};
export const stripeSubscription = {
  id: "sub_fixture",
  customer: "cus_fixture",
  status: "active",
  items: {
    data: [
      {
        id: "si_fixture",
        price: { id: "price_fixture" },
        quantity: 2,
        current_period_start: Date.parse(now) / 1000,
        current_period_end: Date.parse(end) / 1000,
      },
    ],
  },
  pause_collection: null,
  cancel_at_period_end: false,
};
export const lemonAttributes = {
  customer_id: 42,
  variant_id: 21,
  status: "active",
  payment_processor: "stripe",
  renews_at: end,
  ends_at: null,
  first_subscription_item: { id: 100, quantity: 2, is_usage_based: false },
};
export const lemonSubscription = (
  attributes: Readonly<Record<string, unknown>> = lemonAttributes,
) => ({ data: { type: "subscriptions", id: "84", attributes } });
