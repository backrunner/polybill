import { createWebCryptoPort, hmacSha256, utf8 } from "@polybill/adapter-kit";
import { money, parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createLemonSqueezyAdapter } from "../src/index.js";

describe("Lemon Squeezy webhook contract", () => {
  it("locks the requested variant and explicitly creates a test checkout with an integer price", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://api.lemonsqueezy.com/v1/checkouts",
        response: Response.json(
          jsonApi("checkouts", "checkout_fixture", {
            url: "https://store.lemonsqueezy.com/checkout/fixture",
          }),
        ),
      },
    ]);
    const ctx = {
      ...context(scripted.fetch),
      credentials: { apiKey: "lemon_fixture_key", storeId: "42" },
    };
    await createLemonSqueezyAdapter().checkout?.create(ctx, {
      orderId: parseId<"OrderId">("ord_lemoncustom", "ord"),
      lines: [
        {
          skuId: parseId<"SkuId">("sku_lemoncustom", "sku"),
          quantity: 1,
          price: { kind: "custom" },
          unitAmount: money("2500", "USD"),
          externalPriceId: "21",
        },
      ],
      grossTotal: money("2500", "USD"),
      total: money("2500", "USD"),
      successUrl: "https://merchant.example/ok",
      cancelUrl: "https://merchant.example/cancel",
      metadata: {},
    });
    expect(await scripted.requests[0]?.json()).toMatchObject({
      data: {
        attributes: {
          test_mode: true,
          custom_price: 2500,
          product_options: { enabled_variants: [21] },
        },
      },
    });
    scripted.assertConsumed();
  });

  it("does not collapse later subscription updates into the same canonical event", async () => {
    const adapter = createLemonSqueezyAdapter();
    const ctx = context(globalThis.fetch);
    const ids: string[] = [];
    for (const status of ["active", "paused"]) {
      const body = JSON.stringify({
        meta: { event_name: "subscription_updated", test_mode: true },
        data: { id: "84", attributes: { status } },
      });
      const input = {
        rawBody: utf8(body),
        headers: new Headers({ "x-signature": hex(await hmacSha256("secret", utf8(body))) }),
        secret: { active: "secret", activeKeyId: "current" },
        environment: "test" as const,
        now: ctx.clock.now(),
      };
      const verified = await adapter.webhooks.verify(input);
      const events = await adapter.webhooks.map(adapter.webhooks.decode(verified), {
        tenantId: ctx.tenantId,
        connection: ctx.connection,
        observedAt: ctx.clock.now(),
        lookup: { findCanonicalId: async () => "sub_canonical" },
      });
      ids.push(events[0]?.id ?? "missing");
      await expect(
        adapter.webhooks.verify({ ...input, environment: "live" }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
    }
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("missing");
  });
  it("does not claim synchronous subscription creation", async () => {
    const capability = (
      await createLemonSqueezyAdapter().getCapabilities(context(globalThis.fetch))
    ).capabilities["subscription.create"];
    expect(capability).toMatchObject({ support: "unsupported" });
  });

  it("uses raw HMAC and a deterministic digest delivery key", async () => {
    const body =
      '{"meta":{"event_name":"order_created"},"data":{"id":"order_fixture","attributes":{"created_at":"2026-08-25T00:00:00.000Z"}}}';
    const secret = "lemon-webhook-secret";
    const signature = hex(await hmacSha256(secret, utf8(body)));
    const adapter = createLemonSqueezyAdapter();
    const input = {
      rawBody: utf8(body),
      headers: new Headers({ "x-signature": signature }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test" as const,
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    };
    const first = await adapter.webhooks.verify(input);
    const second = await adapter.webhooks.verify(input);
    expect(first.deliveryKey).toMatch(/^lemonSqueezy:[0-9a-f]{64}$/);
    expect(second.deliveryKey).toBe(first.deliveryKey);
  });

  it("maps JSON:API customer and subscription lifecycle resources", async () => {
    const customer = jsonApi("customers", "42", {
      email: "buyer@example.com",
      name: "Buyer",
      urls: { customer_portal: "https://app.lemonsqueezy.com/my-orders/fixture" },
    });
    const subscription = jsonApi("subscriptions", "84", {
      customer_id: 42,
      variant_id: 21,
      variant_quantity: 2,
      status: "active",
      renews_at: "2026-09-01T00:00:00.000Z",
      ends_at: null,
    });
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/customers/42",
        response: Response.json(customer),
      },
      {
        method: "PATCH",
        url: "https://api.lemonsqueezy.com/v1/customers/42",
        response: Response.json(
          jsonApi("customers", "42", { ...customer.data.attributes, name: "Updated" }),
        ),
      },
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/customers/42",
        response: Response.json(customer),
      },
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(subscription),
      },
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(subscription),
      },
      {
        method: "PATCH",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(
          jsonApi("subscriptions", "84", { ...subscription.data.attributes, status: "paused" }),
        ),
      },
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(subscription),
      },
      {
        method: "PATCH",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(subscription),
      },
      {
        method: "DELETE",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(
          jsonApi("subscriptions", "84", {
            ...subscription.data.attributes,
            status: "cancelled",
            ends_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
      },
    ]);
    const adapter = createLemonSqueezyAdapter();
    const ctx = context(scripted.fetch);
    await expect(adapter.customers?.get?.(ctx, "42")).resolves.toMatchObject({
      value: { email: "buyer@example.com" },
    });
    await expect(
      adapter.customers?.update?.(ctx, "42", { name: "Updated" }),
    ).resolves.toMatchObject({ value: { name: "Updated" } });
    await expect(
      adapter.customers?.portal?.(ctx, "42", "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://app.lemonsqueezy.com/my-orders/fixture" } });
    await expect(adapter.subscriptions?.get?.(ctx, "84")).resolves.toMatchObject({
      value: { status: "active", items: [{ externalPriceId: "21", quantity: 2 }] },
    });
    await expect(
      adapter.subscriptions?.pause?.(ctx, "84", {
        timing: "period_end",
        invoiceBehavior: "void",
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      adapter.subscriptions?.pause?.(ctx, "84", {
        timing: "immediately",
        invoiceBehavior: "void",
      }),
    ).resolves.toMatchObject({ value: { status: "paused" } });
    await expect(adapter.subscriptions?.resume?.(ctx, "84")).resolves.toMatchObject({
      value: { status: "active" },
    });
    await expect(adapter.subscriptions?.cancel?.(ctx, "84", "period_end")).resolves.toMatchObject({
      value: { status: "active", cancelAtPeriodEnd: true },
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  const tenantId = parseId<"TenantId">("ten_lemonfixture", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_lemonfixture", "conn"),
      tenantId,
      provider: "lemonSqueezy" as const,
      environment: "test" as const,
    },
    credentials: { apiKey: "lemon_fixture_key" },
    requestId: parseId<"RequestId">("req_lemonfixture", "req"),
    idempotencyKey: parseIdempotencyKey("lemon-resource-fixture"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

function jsonApi(type: string, id: string, attributes: Readonly<Record<string, unknown>>) {
  return { data: { type, id, attributes } };
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
