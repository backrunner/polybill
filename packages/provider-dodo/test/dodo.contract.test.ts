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
import { createDodoAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_dodo0001", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_dodo0001", "conn"),
  tenantId,
  provider: "dodo",
  environment: "test",
};

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "dodo_test_fixture_key" },
    requestId: parseId<"RequestId">("req_dodo0001", "req"),
    idempotencyKey: parseIdempotencyKey("dodo-checkout-0001"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}

describe("Dodo adapter contract", () => {
  it("does not claim discounts before canonical net totals are connected", async () => {
    const capability = (await createDodoAdapter().getCapabilities(context(globalThis.fetch)))
      .capabilities["checkout.discount"];
    expect(capability).toMatchObject({ support: "unsupported" });
  });

  it("creates checkout sessions only from mapped catalog products", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://test.dodopayments.com/checkouts",
        response: Response.json({
          session_id: "cks_fixture",
          checkout_url: "https://checkout.dodopayments.test/cks_fixture",
        }),
      },
    ]);
    const adapter = createDodoAdapter();
    const command = {
      orderId: parseId<"OrderId">("ord_dodo0001", "ord"),
      lines: [
        {
          skuId: parseId<"SkuId">("sku_dodo0001", "sku"),
          quantity: 1,
          price: { kind: "one_time" as const, unit: money("2500", "USD") },
          unitAmount: money("2500", "USD"),
          externalPriceId: "pdt_fixture",
        },
      ],
      total: money("2500", "USD"),
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
      metadata: {},
    };
    const result = await adapter.checkout?.create(context(scripted.fetch), command);
    expect(result?.value.url).toContain("cks_fixture");
    const request = scripted.requests[0];
    expect(await request?.clone().json()).toMatchObject({
      product_cart: [{ product_id: "pdt_fixture", quantity: 1 }],
    });
    expect(request?.headers.get("idempotency-key")).toBe("dodo-checkout-0001");
    scripted.assertConsumed();

    const unmapped = {
      ...command,
      lines: command.lines.map((line) => {
        const { externalPriceId, ...withoutMapping } = line;
        void externalPriceId;
        return withoutMapping;
      }),
    };
    await expect(
      adapter.checkout?.create(context(globalThis.fetch), unmapped),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("verifies a fixed Standard Webhooks base64-key vector", async () => {
    const adapter = createDodoAdapter();
    const body =
      '{"type":"payment.succeeded","timestamp":"2025-08-25T00:00:00.000Z","data":{"payment_id":"pay_123"}}';
    const verified = await adapter.webhooks.verify({
      rawBody: new TextEncoder().encode(body),
      headers: new Headers({
        "webhook-id": "msg_123",
        "webhook-timestamp": "1756080000",
        "webhook-signature": "v1,QvfA9HL7+mN+joUqnF46G5t7fXv7ubppqc2ifwEeLqU=",
      }),
      secret: {
        active: "whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
        activeKeyId: "key-current",
      },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("dodo:msg_123");
    const decoded = adapter.webhooks.decode(verified);
    expect(decoded.externalIds.object).toBe("pay_123");
  });

  it("maps customers, subscriptions, and authoritative full refunds", async () => {
    const customer = {
      customer_id: "cus_fixture",
      email: "buyer@example.com",
      name: "Buyer",
    };
    const subscription = {
      subscription_id: "sub_fixture",
      customer,
      product_id: "pdt_fixture",
      quantity: 2,
      status: "active",
      previous_billing_date: "2026-08-01T00:00:00.000Z",
      next_billing_date: "2026-09-01T00:00:00.000Z",
      cancel_at_next_billing_date: false,
    };
    const refund = {
      refund_id: "ref_fixture",
      payment_id: "pay_fixture",
      amount: 500,
      currency: "USD",
      status: "succeeded",
    };
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://test.dodopayments.com/customers",
        response: Response.json(customer),
      },
      {
        method: "POST",
        url: "https://test.dodopayments.com/customers/cus_fixture/customer-portal/session?return_url=https%3A%2F%2Fmerchant.example%2Fbilling&send_email=false",
        response: Response.json({ link: "https://portal.dodo.test/fixture" }),
      },
      {
        method: "GET",
        url: "https://test.dodopayments.com/subscriptions/sub_fixture",
        response: Response.json(subscription),
      },
      {
        method: "PATCH",
        url: "https://test.dodopayments.com/subscriptions/sub_fixture",
        response: Response.json({ ...subscription, status: "paused" }),
      },
      {
        method: "PATCH",
        url: "https://test.dodopayments.com/subscriptions/sub_fixture",
        response: Response.json({ ...subscription, cancel_at_next_billing_date: true }),
      },
      {
        method: "POST",
        url: "https://test.dodopayments.com/refunds",
        response: Response.json(refund),
      },
      {
        method: "GET",
        url: "https://test.dodopayments.com/refunds/ref_fixture",
        response: Response.json(refund),
      },
    ]);
    const adapter = createDodoAdapter();
    const ctx = context(scripted.fetch);
    await expect(
      adapter.customers?.create?.(ctx, {
        email: customer.email,
        name: customer.name,
        externalReference: parseId<"CustomerId">("cust_dodofixture", "cust"),
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { externalId: customer.customer_id } });
    await expect(
      adapter.customers?.portal?.(ctx, customer.customer_id, "https://merchant.example/billing"),
    ).resolves.toMatchObject({ value: { url: "https://portal.dodo.test/fixture" } });
    await expect(
      adapter.subscriptions?.get?.(ctx, subscription.subscription_id),
    ).resolves.toMatchObject({
      value: { status: "active", items: [{ externalPriceId: "pdt_fixture", quantity: 2 }] },
    });
    await expect(
      adapter.subscriptions?.pause?.(ctx, subscription.subscription_id, {
        timing: "period_end",
        invoiceBehavior: "stop_billing",
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      adapter.subscriptions?.pause?.(ctx, subscription.subscription_id, {
        timing: "immediately",
        invoiceBehavior: "stop_billing",
      }),
    ).resolves.toMatchObject({ value: { status: "paused" } });
    await expect(
      adapter.subscriptions?.cancel?.(ctx, subscription.subscription_id, "period_end"),
    ).resolves.toMatchObject({ value: { cancelAtPeriodEnd: true } });
    await expect(
      adapter.refunds?.create?.(ctx, { externalPaymentId: refund.payment_id, metadata: {} }),
    ).resolves.toMatchObject({
      value: { externalId: refund.refund_id, amount: money("500", "USD") },
    });
    await expect(adapter.refunds?.get?.(ctx, refund.refund_id)).resolves.toMatchObject({
      value: { status: "succeeded" },
    });
    scripted.assertConsumed();
  });
});
