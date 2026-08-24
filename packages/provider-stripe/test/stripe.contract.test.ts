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

  it("maps catalog, customer, portal, subscription, and refund resources", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://api.stripe.com/v1/products",
        response: Response.json({
          id: "prod_fixture",
          name: "Pro",
          description: "Pro plan",
          active: true,
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/prices",
        response: Response.json({
          id: "price_fixture",
          product: "prod_fixture",
          active: true,
          currency: "usd",
          unit_amount: 2500,
          recurring: { interval: "month", interval_count: 1 },
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/customers",
        response: Response.json({
          id: "cus_fixture",
          email: "buyer@example.com",
          name: "Buyer",
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/billing_portal/sessions",
        response: Response.json({ url: "https://billing.stripe.test/session" }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/subscriptions",
        response: Response.json({
          id: "sub_fixture",
          customer: "cus_fixture",
          status: "active",
          items: { data: [{ price: { id: "price_fixture" }, quantity: 2 }] },
          current_period_start: 1756080000,
          current_period_end: 1758758400,
          cancel_at_period_end: false,
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/refunds",
        response: Response.json({
          id: "re_fixture",
          payment_intent: "pi_fixture",
          amount: 500,
          currency: "usd",
          status: "succeeded",
        }),
      },
    ]);
    const adapter = createStripeAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.catalog?.createProduct?.(ctx, {
        name: "Pro",
        description: "Pro plan",
        metadata: { source: "polybill" },
      }),
    ).resolves.toMatchObject({ value: { externalId: "prod_fixture", status: "active" } });
    await expect(
      adapter.catalog?.createPrice?.(ctx, {
        externalProductId: "prod_fixture",
        model: {
          kind: "recurring",
          unit: money("2500", "USD"),
          interval: { unit: "month", count: 1 },
        },
        taxBehavior: "exclusive",
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: "price_fixture", status: "active" } });
    await expect(
      adapter.customers?.create?.(ctx, {
        email: "buyer@example.com",
        name: "Buyer",
        externalReference: parseId<"CustomerId">("cust_fixture", "cust"),
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: "cus_fixture", status: "active" } });
    await expect(
      adapter.customers?.portal?.(ctx, "cus_fixture", "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://billing.stripe.test/session" } });
    await expect(
      adapter.subscriptions?.create?.(ctx, {
        externalCustomerId: "cus_fixture",
        items: [{ externalPriceId: "price_fixture", quantity: 2 }],
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: "sub_fixture", status: "active" } });
    await expect(
      adapter.refunds?.create?.(ctx, {
        externalPaymentId: "pi_fixture",
        amount: money("500", "USD"),
        metadata: {},
      }),
    ).resolves.toMatchObject({
      value: { externalId: "re_fixture", amount: money("500", "USD") },
    });
    expect(await scripted.requests[1]?.clone().text()).toContain("recurring%5Binterval%5D=month");
    expect(await scripted.requests[4]?.clone().text()).toContain(
      "items%5B0%5D%5Bprice%5D=price_fixture",
    );
    scripted.assertConsumed();
  });

  it("rejects a lossy subscription trial conversion before transport", async () => {
    const adapter = createStripeAdapter();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    await expect(
      adapter.subscriptions?.create?.(context(fetch), {
        externalCustomerId: "cus_fixture",
        items: [{ externalPriceId: "price_fixture", quantity: 1 }],
        trial: { unit: "month", count: 1 },
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(calls).toBe(0);
  });

  it("updates and archives products and tombstones customers", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://api.stripe.com/v1/products/prod_fixture",
        response: Response.json({ id: "prod_fixture", name: "Pro Plus", active: true }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/products/prod_fixture",
        response: Response.json({ id: "prod_fixture", name: "Pro Plus", active: false }),
      },
      {
        method: "DELETE",
        url: "https://api.stripe.com/v1/customers/cus_fixture",
        response: Response.json({ id: "cus_fixture", deleted: true }),
      },
    ]);
    const adapter = createStripeAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.catalog?.updateProduct?.(ctx, "prod_fixture", { name: "Pro Plus" }),
    ).resolves.toMatchObject({ value: { name: "Pro Plus", status: "active" } });
    await expect(adapter.catalog?.archiveProduct?.(ctx, "prod_fixture")).resolves.toMatchObject({
      value: { status: "archived" },
    });
    await expect(adapter.customers?.tombstone?.(ctx, "cus_fixture")).resolves.toMatchObject({
      value: { status: "tombstoned" },
    });
    scripted.assertConsumed();
  });

  it("changes subscription items with explicit proration and maps pause collection semantics", async () => {
    const active = {
      id: "sub_fixture",
      customer: "cus_fixture",
      status: "active",
      pause_collection: null,
      items: {
        data: [{ id: "si_fixture", price: { id: "price_old" }, quantity: 1 }],
      },
      current_period_start: 1_756_080_000,
      current_period_end: 1_758_758_400,
      cancel_at_period_end: false,
    };
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://api.stripe.com/v1/subscriptions/sub_fixture",
        response: Response.json(active),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/subscriptions/sub_fixture",
        response: Response.json({
          ...active,
          items: { data: [{ id: "si_fixture", price: { id: "price_old" }, quantity: 3 }] },
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/subscriptions/sub_fixture",
        response: Response.json({ ...active, pause_collection: { behavior: "void" } }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/subscriptions/sub_fixture",
        response: Response.json(active),
      },
    ]);
    const adapter = createStripeAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.subscriptions?.changeItems?.(ctx, "sub_fixture", {
        items: [{ externalPriceId: "price_old", quantity: 3 }],
        policy: { timing: "immediately", proration: "prorate_immediately" },
      }),
    ).resolves.toMatchObject({ value: { items: [{ quantity: 3 }] } });
    expect(await scripted.requests[1]?.clone().text()).toContain(
      "proration_behavior=always_invoice",
    );
    expect(await scripted.requests[1]?.clone().text()).toContain("items%5B0%5D%5Bid%5D=si_fixture");
    await expect(
      adapter.subscriptions?.pause?.(ctx, "sub_fixture", {
        timing: "immediately",
        invoiceBehavior: "void",
      }),
    ).resolves.toMatchObject({ value: { status: "paused" } });
    await expect(adapter.subscriptions?.resume?.(ctx, "sub_fixture")).resolves.toMatchObject({
      value: { status: "active" },
    });
    scripted.assertConsumed();
  });

  it("rejects unsupported Stripe subscription mutation policies before transport", async () => {
    let calls = 0;
    const adapter = createStripeAdapter();
    const ctx = context(async () => {
      calls += 1;
      return Response.json({});
    });
    await expect(
      adapter.subscriptions?.changeItems?.(ctx, "sub_fixture", {
        items: [{ externalPriceId: "price_fixture", quantity: 1 }],
        policy: { timing: "period_end", proration: "none" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      adapter.subscriptions?.pause?.(ctx, "sub_fixture", {
        timing: "immediately",
        invoiceBehavior: "stop_billing",
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(calls).toBe(0);
  });
});
