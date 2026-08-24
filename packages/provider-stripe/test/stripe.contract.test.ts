import { createWebCryptoPort } from "@polybill/adapter-kit";
import {
  money,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type ConnectionRef,
} from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createStripeAdapter, STRIPE_API_VERSION } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_stripe01", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_stripe01", "conn"),
  tenantId,
  provider: "stripe",
  environment: "test",
};

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "sk_test_fixture" },
    requestId: parseId<"RequestId">("req_stripe01", "req"),
    idempotencyKey: parseIdempotencyKey("stripe-checkout-0001"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

describe("Stripe adapter contract", () => {
  it("creates an inline hosted checkout with pinned API version and idempotency", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://api.stripe.com/v1/checkout/sessions",
        response: Response.json({
          id: "cs_test_123",
          status: "open",
          url: "https://checkout.stripe.test/cs_test_123",
          expires_at: 1787616000,
        }),
      },
    ]);
    const adapter = createStripeAdapter();
    const result = await adapter.checkout?.create(context(scripted.fetch), {
      orderId: parseId<"OrderId">("ord_stripe01", "ord"),
      lines: [
        {
          skuId: parseId<"SkuId">("sku_stripe01", "sku"),
          quantity: 2,
          price: { kind: "one_time", unit: money("1250", "USD") },
          unitAmount: money("1250", "USD"),
        },
      ],
      total: money("2500", "USD"),
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
      metadata: { source: "test" },
    });
    expect(result?.value.externalId).toBe("cs_test_123");
    const sent = scripted.requests[0];
    expect(sent?.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(sent?.headers.get("idempotency-key")).toBe("stripe-checkout-0001");
    expect(await sent?.clone().text()).toContain(
      "line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1250",
    );
    scripted.assertConsumed();
  });

  it("verifies a fixed Stripe HMAC vector over exact raw bytes", async () => {
    const adapter = createStripeAdapter();
    const body =
      '{"id":"evt_123","type":"checkout.session.completed","created":1756080000,"data":{"object":{"id":"cs_test_123"}}}';
    const verified = await adapter.webhooks.verify({
      rawBody: new TextEncoder().encode(body),
      headers: new Headers({
        "Stripe-Signature":
          "t=1756080000,v1=df29513867273f0b96a96efc29cbbd8c6cb2190012a8bc0730a6f51423dfb1c9",
      }),
      secret: { active: "whsec_fixture", activeKeyId: "key-current" },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("stripe:evt_123");
    const decoded = adapter.webhooks.decode(verified);
    const mapped = await adapter.webhooks.map(decoded, {
      tenantId,
      connection,
      observedAt: verified.verifiedAt,
      lookup: { findCanonicalId: async () => undefined },
    });
    expect(mapped[0]?.type).toBe("unmapped_provider_event.v1");
  });

  it("rejects timestamp replay and environment-mismatched credentials", async () => {
    const adapter = createStripeAdapter();
    const body = new TextEncoder().encode('{"id":"evt_123"}');
    await expect(
      adapter.webhooks.verify({
        rawBody: body,
        headers: new Headers({ "Stripe-Signature": "t=1756080000,v1=bad" }),
        secret: { active: "whsec_fixture", activeKeyId: "key-current" },
        environment: "live",
        now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "replay_rejected" });
    const liveContext = {
      ...context(globalThis.fetch),
      connection: { ...connection, environment: "live" as const },
    };
    await expect(adapter.checkout?.get(liveContext, "cs_test_123")).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });
});
