import { createWebCryptoPort, hmacSha256, joinBytes, utf8 } from "@polybill/adapter-kit";
import { parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../src/index.js";

describe("Polar webhook contract", () => {
  it("does not claim discounts before canonical net totals are connected", async () => {
    const capability = (await createPolarAdapter().getCapabilities(context(globalThis.fetch)))
      .capabilities["checkout.discount"];
    expect(capability).toMatchObject({ support: "unsupported" });
  });

  it("verifies Standard Webhooks over exact raw bytes", async () => {
    const body = '{"type":"order.paid","data":{"id":"order_fixture"}}';
    const id = "msg_fixture";
    const timestamp = 1_756_080_000;
    const secret = "polar-webhook-secret";
    const signature = base64(
      await hmacSha256(secret, joinBytes(utf8(`${id}.${timestamp}.`), utf8(body))),
    );
    const verified = await createPolarAdapter().webhooks.verify({
      rawBody: utf8(body),
      headers: new Headers({
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
      }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("polar:msg_fixture");
    expect(createPolarAdapter().webhooks.decode(verified).externalIds.object).toBe("order_fixture");
  });

  it("maps customers, portal sessions, and subscription cancellation", async () => {
    const customer = {
      id: "cust_fixture",
      email: "buyer@example.com",
      name: "Buyer",
      deleted_at: null,
    };
    const subscription = {
      id: "sub_fixture",
      customer_id: customer.id,
      product_id: "prod_fixture",
      seats: 2,
      status: "active",
      current_period_start: "2026-08-01T00:00:00.000Z",
      current_period_end: "2026-09-01T00:00:00.000Z",
      cancel_at_period_end: false,
    };
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://sandbox-api.polar.sh/v1/customers/",
        response: Response.json(customer),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.polar.sh/v1/customers/${customer.id}`,
        response: Response.json({ ...customer, name: "Updated" }),
      },
      {
        method: "POST",
        url: "https://sandbox-api.polar.sh/v1/customer-sessions/",
        response: Response.json({
          customer_portal_url: "https://polar.sh/portal/fixture",
          expires_at: "2026-08-25T01:00:00.000Z",
        }),
      },
      {
        method: "GET",
        url: `https://sandbox-api.polar.sh/v1/subscriptions/${subscription.id}`,
        response: Response.json(subscription),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.polar.sh/v1/subscriptions/${subscription.id}`,
        response: Response.json({ ...subscription, cancel_at_period_end: true }),
      },
      {
        method: "PATCH",
        url: `https://sandbox-api.polar.sh/v1/subscriptions/${subscription.id}`,
        response: Response.json(subscription),
      },
      {
        method: "DELETE",
        url: `https://sandbox-api.polar.sh/v1/customers/${customer.id}?anonymize=true`,
        response: new Response(null, { status: 204 }),
      },
    ]);
    const adapter = createPolarAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.customers?.create?.(ctx, {
        email: customer.email,
        name: customer.name,
        externalReference: parseId<"CustomerId">("cust_polarfixture", "cust"),
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: customer.id } });
    await expect(
      adapter.customers?.update?.(ctx, customer.id, { name: "Updated" }),
    ).resolves.toMatchObject({ value: { name: "Updated" } });
    await expect(
      adapter.customers?.portal?.(ctx, customer.id, "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://polar.sh/portal/fixture" } });
    await expect(adapter.subscriptions?.get?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active", items: [{ externalPriceId: "prod_fixture", quantity: 2 }] },
    });
    await expect(
      adapter.subscriptions?.cancel?.(ctx, subscription.id, "period_end"),
    ).resolves.toMatchObject({ value: { cancelAtPeriodEnd: true } });
    await expect(adapter.subscriptions?.resume?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active" },
    });
    await expect(adapter.customers?.tombstone?.(ctx, customer.id)).resolves.toMatchObject({
      value: { status: "tombstoned" },
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  const tenantId = parseId<"TenantId">("ten_polarfixture", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_polarfixture", "conn"),
      tenantId,
      provider: "polar" as const,
      environment: "test" as const,
    },
    credentials: { accessToken: "polar_fixture_token" },
    requestId: parseId<"RequestId">("req_polarfixture", "req"),
    idempotencyKey: parseIdempotencyKey("polar-resource-fixture"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

function base64(value: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...value));
}
