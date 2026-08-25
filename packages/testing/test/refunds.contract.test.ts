import { CheckoutService, RefundService, ResourceRuntime } from "@polybill/application";
import {
  money,
  parseId,
  parseIdempotencyKey,
  type ConnectionRef,
  type Price,
} from "@polybill/core";
import { createMemoryStore } from "@polybill/store-memory";
import { describe, expect, it } from "vitest";
import {
  createFakeProvider,
  createWebCryptoPort,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_refund01", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_refund01", "conn"),
  tenantId,
  provider: "fake",
  environment: "test",
};
const price: Price = {
  id: parseId<"PriceId">("price_refund01", "price"),
  skuId: parseId<"SkuId">("sku_refund01", "sku"),
  version: 1,
  model: { kind: "one_time", unit: money("2500", "USD") },
  taxBehavior: "exclusive",
  status: "active",
  metadata: {},
};

function setup() {
  const store = createMemoryStore();
  store.seedPrice(tenantId, price);
  const adapter = createFakeProvider();
  const common = {
    tenantId,
    connection,
    credentials: { apiKey: "test" },
    adapter,
    store,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
    ids: new DeterministicIds(),
    fetch: globalThis.fetch,
    logger: silentLogger,
  } as const;
  return {
    store,
    checkout: new CheckoutService(common),
    refunds: new RefundService(new ResourceRuntime(common)),
  };
}

describe("refund ledger contract", () => {
  it("projects successful refunds and rejects amounts above the remaining balance", async () => {
    const { checkout, refunds, store } = setup();
    const created = await checkout.create({
      idempotencyKey: parseIdempotencyKey("refund:checkout:0001"),
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });
    store.seedMapping(tenantId, connection.id, "payment", created.payment.id, "pay_external_1");

    const first = await refunds.create({
      idempotencyKey: parseIdempotencyKey("refund:create:0001"),
      paymentId: created.payment.id,
      amount: money("1000", "USD"),
    });
    expect(first.status).toBe("succeeded");
    await expect(
      refunds.create({
        idempotencyKey: parseIdempotencyKey("refund:create:0002"),
        paymentId: created.payment.id,
        amount: money("1600", "USD"),
      }),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    await expect(
      refunds.create({
        idempotencyKey: parseIdempotencyKey("refund:create:0003"),
        paymentId: created.payment.id,
        amount: money("500", "USD"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await expect(refunds.get(first.id)).resolves.toEqual(first);
    await expect(store.getResource(tenantId, "payment", created.payment.id)).resolves.toMatchObject(
      {
        refundedAmount: money("1500", "USD"),
      },
    );
    await expect(store.getResource(tenantId, "order", created.order.id)).resolves.toMatchObject({
      paymentStatus: "partially_refunded",
    });
  });
});
