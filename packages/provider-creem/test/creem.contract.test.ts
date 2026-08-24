import { createWebCryptoPort, hmacSha256, utf8 } from "@polybill/adapter-kit";
import { parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../src/index.js";

describe("Creem webhook contract", () => {
  it("verifies raw-body HMAC and rejects JSON reserialization", async () => {
    const body =
      '{"id":"evt_fixture","eventType":"checkout.completed","object":{"id":"ch_fixture"}}';
    const secret = "creem-webhook-secret";
    const signature = hex(await hmacSha256(secret, utf8(body)));
    const input = {
      rawBody: utf8(body),
      headers: new Headers({ "creem-signature": signature }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test" as const,
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    };
    const verified = await createCreemAdapter().webhooks.verify(input);
    expect(verified.deliveryKey).toBe("creem:evt_fixture");
    await expect(
      createCreemAdapter().webhooks.verify({
        ...input,
        rawBody: utf8(`${body}\n`),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("maps customer and subscription lifecycle fixtures from the pinned OpenAPI", async () => {
    const customer = {
      id: "cust_fixture",
      email: "buyer@example.com",
      name: "Buyer",
    };
    const subscription = {
      id: "sub_fixture",
      status: "active",
      customer,
      product: "prod_fixture",
      current_period_start_date: "2026-08-01T00:00:00.000Z",
      current_period_end_date: "2026-09-01T00:00:00.000Z",
    };
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/customers",
        response: Response.json(customer),
      },
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/customers?customer_id=cust_fixture",
        response: Response.json(customer),
      },
      {
        method: "PATCH",
        url: "https://test-api.creem.io/v1/customers",
        response: Response.json({ ...customer, name: "Updated" }),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/customers/billing",
        response: Response.json({ customer_portal_link: "https://creem.io/portal/fixture" }),
      },
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/subscriptions?subscription_id=sub_fixture",
        response: Response.json(subscription),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/subscriptions/sub_fixture/cancel",
        response: Response.json({ ...subscription, status: "scheduled_cancel" }),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/subscriptions/sub_fixture/pause",
        response: Response.json({ ...subscription, status: "paused" }),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/subscriptions/sub_fixture/resume",
        response: Response.json(subscription),
      },
    ]);
    const adapter = createCreemAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.customers?.create?.(ctx, {
        email: customer.email,
        name: customer.name,
        externalReference: parseId<"CustomerId">("cust_canonical", "cust"),
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: customer.id, status: "active" } });
    await expect(adapter.customers?.get?.(ctx, customer.id)).resolves.toMatchObject({
      value: { externalId: customer.id, email: customer.email, name: customer.name },
    });
    await expect(
      adapter.customers?.update?.(ctx, customer.id, { name: "Updated" }),
    ).resolves.toMatchObject({ value: { name: "Updated" } });
    await expect(
      adapter.customers?.portal?.(ctx, customer.id, "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://creem.io/portal/fixture" } });
    await expect(adapter.subscriptions?.get?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active", externalCustomerId: customer.id },
    });
    await expect(
      adapter.subscriptions?.cancel?.(ctx, subscription.id, "period_end"),
    ).resolves.toMatchObject({ value: { status: "active", cancelAtPeriodEnd: true } });
    await expect(adapter.subscriptions?.pause?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "paused" },
    });
    await expect(adapter.subscriptions?.resume?.(ctx, subscription.id)).resolves.toMatchObject({
      value: { status: "active" },
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  const tenantId = parseId<"TenantId">("ten_creemfixture", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_creemfixture", "conn"),
      tenantId,
      provider: "creem" as const,
      environment: "test" as const,
    },
    credentials: { apiKey: "creem_fixture_key" },
    requestId: parseId<"RequestId">("req_creemfixture", "req"),
    idempotencyKey: parseIdempotencyKey("creem-resource-fixture"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
