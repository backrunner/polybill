import { createPolybill, createWebSecretCrypto } from "../src/index.js";
import { money, parseId, parseIdempotencyKey, type Price } from "@polybill/core";
import { createMemoryLicensingStore, createMemoryStore } from "@polybill/store-memory";
import {
  createFakeProvider,
  createWebCryptoPort,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "@polybill/testing";
import { describe, expect, it } from "vitest";

const tenantId = parseId<"TenantId">("ten_facade01", "ten");
const connection = {
  id: parseId<"ConnectionId">("conn_facade01", "conn"),
  tenantId,
  provider: "fake",
  environment: "test",
} as const;
const price: Price = {
  id: parseId<"PriceId">("price_facade01", "price"),
  skuId: parseId<"SkuId">("sku_facade01", "sku"),
  version: 1,
  model: { kind: "one_time", unit: money("1200", "USD") },
  taxBehavior: "exclusive",
  status: "active",
  metadata: {},
};

describe("polybill facade", () => {
  it("composes a provider-neutral checkout client", async () => {
    const store = createMemoryStore();
    store.seedPrice(tenantId, price);
    const client = createPolybill({
      tenantId,
      connection,
      credentials: { apiKey: "test" },
      adapter: createFakeProvider(),
      store,
      crypto: createWebCryptoPort(),
      clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
      ids: new DeterministicIds(),
      logger: silentLogger,
    });

    const capabilities = await client.getCapabilities();
    const result = await client.checkouts.create({
      idempotencyKey: parseIdempotencyKey("facade:checkout:0001"),
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });

    expect(capabilities.provider).toBe("fake");
    expect(result.order.total).toEqual(money("1200", "USD"));
  });

  it("manages canonical resources without exposing provider IDs", async () => {
    const store = createMemoryStore();
    const licensingStore = createMemoryLicensingStore();
    const client = createPolybill({
      tenantId,
      connection,
      credentials: { apiKey: "test" },
      adapter: createFakeProvider(),
      store,
      crypto: createWebCryptoPort(),
      clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
      ids: new DeterministicIds(),
      logger: silentLogger,
      licensing: {
        store: licensingStore,
        crypto: createWebSecretCrypto({
          digestKey: new Uint8Array(32).fill(21),
          activeEncryptionKeyId: "test-key",
          encryptionKeys: { "test-key": new Uint8Array(32).fill(22) },
        }),
      },
    });
    const productCommand = {
      idempotencyKey: parseIdempotencyKey("facade:product:0001"),
      name: "Pro",
      metadata: { source: "facade-test" },
    };
    const product = await client.catalog.createProduct(productCommand);
    const replay = await client.catalog.createProduct(productCommand);
    expect(replay.id).toBe(product.id);
    expect(product.id).not.toContain("fake_product");

    const sku = await client.catalog.createSku({
      idempotencyKey: parseIdempotencyKey("facade:sku:0001"),
      productId: product.id,
      key: "pro-monthly",
      fulfillment: "service",
    });
    const createdPrice = await client.catalog.createPrice({
      idempotencyKey: parseIdempotencyKey("facade:price:0001"),
      skuId: sku.id,
      model: {
        kind: "recurring",
        unit: money("2500", "USD"),
        interval: { unit: "month", count: 1 },
      },
      taxBehavior: "exclusive",
    });
    const customer = await client.customers.create({
      idempotencyKey: parseIdempotencyKey("facade:customer:0001"),
      externalId: "host-user-123",
      email: "buyer@example.com",
    });
    const subscription = await client.subscriptions.create({
      idempotencyKey: parseIdempotencyKey("facade:subscription:0001"),
      customerId: customer.id,
      items: [{ priceId: createdPrice.id, quantity: 1 }],
    });
    expect(subscription.status).toBe("active");
    expect(subscription.items).toEqual([{ priceId: createdPrice.id, quantity: 1 }]);

    const checkout = await client.checkouts.create({
      idempotencyKey: parseIdempotencyKey("facade:resource-checkout:0001"),
      customerId: customer.id,
      items: [{ priceId: createdPrice.id, quantity: 1 }],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });
    await expect(client.orders.get(checkout.order.id)).resolves.toEqual(checkout.order);
    await expect(client.payments.get(checkout.payment.id)).resolves.toEqual(checkout.payment);

    store.seedMapping(
      tenantId,
      connection.id,
      "payment",
      checkout.payment.id,
      "fake_payment_settled_1",
    );
    const refund = await client.refunds.create({
      idempotencyKey: parseIdempotencyKey("facade:refund:0001"),
      paymentId: checkout.payment.id,
      amount: money("500", "USD"),
    });
    expect(refund.paymentId).toBe(checkout.payment.id);
    expect(refund.amount).toEqual(money("500", "USD"));

    const licenseService = client.licenses;
    if (licenseService === undefined) throw new Error("Expected configured license service");
    const issued = await licenseService.issue({
      tenantId,
      grantId: parseId<"EntitlementGrantId">("grant_facade01", "grant"),
      issuanceKey: "facade-license-0001",
      activationLimit: 1,
      ownerRef: customer.id,
    });
    await expect(licenseService.validate({ tenantId, key: issued.key })).resolves.toMatchObject({
      id: issued.license.id,
      ownerRef: customer.id,
    });
  });
});
