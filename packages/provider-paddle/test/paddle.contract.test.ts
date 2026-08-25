import { createWebCryptoPort, hmacSha256, joinBytes, utf8 } from "@polybill/adapter-kit";
import { money, parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPaddleAdapter } from "../src/index.js";

describe("Paddle Billing webhook contract", () => {
  it("does not claim synchronous subscription creation", async () => {
    const capability = (await createPaddleAdapter().getCapabilities(context(globalThis.fetch)))
      .capabilities["subscription.create"];
    expect(capability).toMatchObject({ support: "unsupported" });
  });

  it("does not claim safe partial refunds without adjustment history", async () => {
    const capability = (await createPaddleAdapter().getCapabilities(context(globalThis.fetch)))
      .capabilities["refund.partial"];
    expect(capability).toMatchObject({ support: "unsupported" });
  });

  it("verifies timestamp and raw body using the Billing signature format", async () => {
    const body =
      '{"event_id":"evt_fixture","event_type":"transaction.completed","occurred_at":"2025-08-25T00:00:00.000Z","data":{"id":"txn_fixture"}}';
    const secret = "paddle-webhook-secret";
    const timestamp = 1_756_080_000;
    const signature = hex(await hmacSha256(secret, joinBytes(utf8(`${timestamp}:`), utf8(body))));
    const verified = await createPaddleAdapter().webhooks.verify({
      rawBody: utf8(body),
      headers: new Headers({ "paddle-signature": `ts=${timestamp};h1=${signature}` }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("paddle:evt_fixture");
  });

  it("maps Billing products, prices, customers, and portal sessions", async () => {
    const product = { id: "pro_fixture", name: "Pro", description: "Plan", status: "active" };
    const price = {
      id: "pri_fixture",
      product_id: product.id,
      status: "active",
      unit_price: { amount: "2500", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
    };
    const customer = {
      id: "ctm_fixture",
      email: "buyer@example.com",
      name: "Buyer",
      status: "active",
    };
    const subscription = {
      id: "sub_fixture",
      customer_id: customer.id,
      status: "active",
      items: [{ price, quantity: 2 }],
      current_billing_period: {
        starts_at: "2026-08-01T00:00:00.000Z",
        ends_at: "2026-09-01T00:00:00.000Z",
      },
      scheduled_change: null,
    };
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://sandbox-api.paddle.com/products",
        response: Response.json({ data: product }),
      },
      {
        method: "POST",
        url: "https://sandbox-api.paddle.com/prices",
        response: Response.json({ data: price }),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.paddle.com/products/${product.id}`,
        response: Response.json({ data: { ...product, name: "Pro Plus" } }),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.paddle.com/prices/${price.id}`,
        response: Response.json({ data: { ...price, status: "archived" } }),
      },
      {
        method: "POST",
        url: "https://sandbox-api.paddle.com/customers",
        response: Response.json({ data: customer }),
      },
      {
        method: "POST",
        url: `https://sandbox-api.paddle.com/customers/${customer.id}/portal-sessions`,
        response: Response.json({
          data: { urls: { general: { overview: "https://customer-portal.paddle.com/fixture" } } },
        }),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.paddle.com/customers/${customer.id}`,
        response: Response.json({ data: { ...customer, status: "archived" } }),
      },
      {
        method: "GET",
        url: `https://sandbox-api.paddle.com/subscriptions/${subscription.id}`,
        response: Response.json({ data: subscription }),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.paddle.com/subscriptions/${subscription.id}`,
        response: Response.json({
          data: { ...subscription, items: [{ price, quantity: 3 }] },
        }),
      },
      {
        method: "POST",
        url: `https://sandbox-api.paddle.com/subscriptions/${subscription.id}/pause`,
        response: Response.json({ data: { ...subscription, status: "paused" } }),
      },
      {
        method: "POST",
        url: `https://sandbox-api.paddle.com/subscriptions/${subscription.id}/resume`,
        response: Response.json({ data: subscription }),
      },
      {
        method: "POST",
        url: `https://sandbox-api.paddle.com/subscriptions/${subscription.id}/cancel`,
        response: Response.json({
          data: {
            ...subscription,
            scheduled_change: {
              action: "cancel",
              effective_at: "2026-09-01T00:00:00.000Z",
            },
          },
        }),
      },
    ]);
    const adapter = createPaddleAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.catalog?.createProduct?.(ctx, { name: "Pro", description: "Plan", metadata: {} }),
    ).resolves.toMatchObject({ value: { externalId: product.id } });
    await expect(
      adapter.catalog?.createPrice?.(ctx, {
        externalProductId: product.id,
        model: {
          kind: "recurring",
          unit: money("2500", "USD"),
          interval: { unit: "month", count: 1 },
        },
        taxBehavior: "exclusive",
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: price.id, model: { kind: "recurring" } } });
    await expect(
      adapter.catalog?.updateProduct?.(ctx, product.id, { name: "Pro Plus" }),
    ).resolves.toMatchObject({ value: { name: "Pro Plus" } });
    await expect(adapter.catalog?.retirePrice?.(ctx, price.id)).resolves.toMatchObject({
      value: { status: "retired" },
    });
    await expect(
      adapter.customers?.create?.(ctx, {
        email: customer.email,
        name: customer.name,
        externalReference: parseId<"CustomerId">("cust_paddlefixture", "cust"),
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: customer.id } });
    await expect(
      adapter.customers?.portal?.(ctx, customer.id, "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://customer-portal.paddle.com/fixture" } });
    await expect(adapter.customers?.tombstone?.(ctx, customer.id)).resolves.toMatchObject({
      value: { status: "tombstoned" },
    });
    await expect(adapter.subscriptions?.get?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active", items: [{ externalPriceId: price.id, quantity: 2 }] },
    });
    await expect(
      adapter.subscriptions?.changeItems?.(ctx, subscription.id, {
        items: [{ externalPriceId: price.id, quantity: 3 }],
        policy: { timing: "period_end", proration: "none" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      adapter.subscriptions?.changeItems?.(ctx, subscription.id, {
        items: [{ externalPriceId: price.id, quantity: 3 }],
        policy: { timing: "immediately", proration: "prorate_next_invoice" },
      }),
    ).resolves.toMatchObject({ value: { items: [{ externalPriceId: price.id, quantity: 3 }] } });
    await expect(
      adapter.subscriptions?.pause?.(ctx, subscription.id, {
        timing: "immediately",
        invoiceBehavior: "void",
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      adapter.subscriptions?.pause?.(ctx, subscription.id, {
        timing: "immediately",
        invoiceBehavior: "stop_billing",
      }),
    ).resolves.toMatchObject({ value: { status: "paused" } });
    await expect(adapter.subscriptions?.resume?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active" },
    });
    await expect(
      adapter.subscriptions?.cancel?.(ctx, subscription.id, "period_end"),
    ).resolves.toMatchObject({ value: { cancelAtPeriodEnd: true } });
    await expect(scripted.requests.at(-4)?.clone().json()).resolves.toMatchObject({
      proration_billing_mode: "prorated_next_billing_period",
    });
    await expect(scripted.requests.at(-3)?.clone().json()).resolves.toEqual({
      effective_from: "immediately",
    });
    await expect(scripted.requests.at(-2)?.clone().json()).resolves.toEqual({
      effective_from: "immediately",
      on_resume: "start_new_billing_period",
    });
    await expect(scripted.requests.at(-1)?.clone().json()).resolves.toEqual({
      effective_from: "next_billing_period",
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  const tenantId = parseId<"TenantId">("ten_paddlefixture", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_paddlefixture", "conn"),
      tenantId,
      provider: "paddle" as const,
      environment: "test" as const,
    },
    credentials: { apiKey: "pdl_sdbx_fixture" },
    requestId: parseId<"RequestId">("req_paddlefixture", "req"),
    idempotencyKey: parseIdempotencyKey("paddle-resource-fixture"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
