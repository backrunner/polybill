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
});
