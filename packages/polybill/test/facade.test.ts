import { createPolybill, createWebSecretCrypto } from "../src/index.js";
import { money, parseId, parseIdempotencyKey, parseIsoDateTime, type Price } from "@polybill/core";
import { createMemoryLicensingStore, createMemoryStore } from "@polybill/store-memory";
import { MemoryWebhookInbox } from "@polybill/webhooks";
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
      adapter: createFakeProvider({ discount: true }),
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

  it("composes the unified webhook handler and consumer when configured", () => {
    const inbox = new MemoryWebhookInbox();
    const client = createPolybill({
      tenantId,
      connection,
      credentials: { apiKey: "test" },
      adapter: createFakeProvider(),
      store: createMemoryStore(),
      webhooks: {
        inbox,
        queue: inbox,
        resolver: {
          resolve: async () => ({
            tenantId,
            connection,
            secret: { active: "fixture", activeKeyId: "fixture-key" },
          }),
        },
      },
    });

    expect(client.webhooks.handler).toBeTypeOf("function");
    expect(client.webhooks.consume).toBeTypeOf("function");
  });

  it("manages canonical resources without exposing provider IDs", async () => {
    const store = createMemoryStore();
    const licensingStore = createMemoryLicensingStore();
    const client = createPolybill({
      tenantId,
      connection,
      credentials: { apiKey: "test" },
      adapter: createFakeProvider({ discount: true }),
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
    const legacyOrderId = parseId<"OrderId">("ord_legacyfacade", "ord");
    await store.commitResource({
      tenantId,
      connectionId: connection.id,
      provider: "fake",
      entityType: "order",
      entityId: legacyOrderId,
      value: {
        id: legacyOrderId,
        lines: [],
        total: money("500", "USD"),
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        commercialTermsRef: parseId<"EvidenceId">("evi_legacyfacade", "evi"),
        createdAt: parseIsoDateTime("2026-08-24T00:00:00.000Z"),
      },
      occurredAt: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    });
    await expect(client.orders.get(legacyOrderId)).resolves.toMatchObject({
      grossTotal: money("500", "USD"),
      discounts: [],
      discountTotal: money("0", "USD"),
      total: money("500", "USD"),
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
    const updatedProduct = await client.catalog.updateProduct(product.id, {
      idempotencyKey: parseIdempotencyKey("facade:product:update:0001"),
      name: "Pro Plus",
    });
    expect(updatedProduct).toMatchObject({ name: "Pro Plus", version: 2 });
    await expect(client.catalogSync.diffProduct(product.id)).resolves.toMatchObject({
      status: "matched",
      differences: [],
    });
    await expect(client.catalogSync.diffPrice(createdPrice.id)).resolves.toMatchObject({
      status: "matched",
      differences: [],
    });
    const customer = await client.customers.create({
      idempotencyKey: parseIdempotencyKey("facade:customer:0001"),
      externalId: "host-user-123",
      email: "buyer@example.com",
    });
    await expect(
      client.customers.refresh(customer.id, parseIdempotencyKey("facade:customer:refresh:0001")),
    ).resolves.toMatchObject({ email: "buyer@example.com" });
    const subscription = await client.subscriptions.create({
      idempotencyKey: parseIdempotencyKey("facade:subscription:0001"),
      customerId: customer.id,
      items: [{ priceId: createdPrice.id, quantity: 1 }],
    });
    expect(subscription.status).toBe("active");
    expect(subscription.items).toEqual([{ priceId: createdPrice.id, quantity: 1 }]);
    const changed = await client.subscriptions.changeItems(
      subscription.id,
      parseIdempotencyKey("facade:subscription:items:0001"),
      [{ priceId: createdPrice.id, quantity: 2 }],
      { timing: "immediately", proration: "none" },
    );
    expect(changed.items).toEqual([{ priceId: createdPrice.id, quantity: 2 }]);
    await expect(
      client.subscriptions.pause(
        subscription.id,
        parseIdempotencyKey("facade:subscription:pause:0001"),
        { timing: "immediately", invoiceBehavior: "stop_billing" },
      ),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      client.subscriptions.resume(
        subscription.id,
        parseIdempotencyKey("facade:subscription:resume:0001"),
      ),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      client.subscriptions.refresh(
        subscription.id,
        parseIdempotencyKey("facade:subscription:refresh:0001"),
      ),
    ).resolves.toMatchObject({
      status: "active",
      items: [{ priceId: createdPrice.id, quantity: 2 }],
    });

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
    await expect(
      client.refunds.refresh(refund.id, parseIdempotencyKey("facade:refund:refresh:0001")),
    ).resolves.toEqual(refund);

    const adHoc = await client.checkouts.createAdHoc({
      idempotencyKey: parseIdempotencyKey("facade:adhoc:0001"),
      items: [
        {
          skuId: sku.id,
          quantity: 1,
          price: { kind: "custom", minimum: money("500", "USD") },
          unitAmount: money("700", "USD"),
          persistence: "session",
        },
      ],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });
    expect(adHoc.order.total).toEqual(money("700", "USD"));

    const discountService = client.discounts;
    const discount = await discountService.create({
      idempotencyKey: parseIdempotencyKey("facade:discount:create:0001"),
      code: "WELCOME10",
      name: "Welcome discount",
      value: { kind: "percentage", basisPoints: 1_000 },
      eligibleSkuIds: [sku.id],
    });
    await expect(
      client.discountSync.push(discount.id, parseIdempotencyKey("facade:discount:sync:0001")),
    ).resolves.toMatchObject({ status: "published" });
    await expect(client.discountSync.diff(discount.id)).resolves.toMatchObject({
      status: "matched",
      differences: [],
    });
    await expect(discountService.findByCode("welcome10")).resolves.toEqual(discount);
    await expect(
      discountService.archive(discount.id, parseIdempotencyKey("facade:discount:archive:0001")),
    ).resolves.toMatchObject({ status: "archived" });

    const entitlementService = client.entitlements;
    if (entitlementService === undefined) throw new Error("Expected entitlement service");
    const policy = await entitlementService.createPolicy({
      tenantId,
      idempotencyKey: "facade-policy-0001",
      benefit: "app:pro",
      revokeOn: "subscription_end",
      gracePeriodSeconds: 3600,
    });
    const grant = await entitlementService.grant({
      tenantId,
      idempotencyKey: "facade-grant-0001",
      policyId: policy.id,
      beneficiaryRef: customer.id,
      source: "order",
      sourceRef: checkout.order.id,
    });
    const licenseService = client.licenses;
    if (licenseService === undefined) throw new Error("Expected configured license service");
    const issued = await licenseService.issue({
      tenantId,
      grantId: grant.id,
      issuanceKey: "facade-license-0001",
      activationLimit: 1,
      ownerRef: customer.id,
    });
    await expect(licenseService.validate({ tenantId, key: issued.key })).resolves.toMatchObject({
      id: issued.license.id,
      ownerRef: customer.id,
    });

    await expect(
      client.customers.update(customer.id, {
        idempotencyKey: parseIdempotencyKey("facade:customer:update:0001"),
        name: "Updated Buyer",
      }),
    ).resolves.toMatchObject({ name: "Updated Buyer", status: "active" });
    const reconciliation = await client.reconcile.run({
      stream: "mutable-resources",
      mode: "report_only",
      idempotencyKey: parseIdempotencyKey("facade:reconcile:0001"),
    });
    expect(reconciliation.items).toHaveLength(3);
    expect(reconciliation.items.every((item) => item.status === "matched")).toBe(true);
    await expect(
      client.reconcile.run({
        stream: "mutable-resources",
        mode: "report_only",
        idempotencyKey: parseIdempotencyKey("facade:reconcile:0002"),
      }),
    ).resolves.toMatchObject({ items: [], sequence: 3 });
    await expect(
      client.customers.tombstone(customer.id, parseIdempotencyKey("facade:customer:delete:0001")),
    ).resolves.toMatchObject({ status: "tombstoned" });
    await expect(
      client.catalog.retirePrice(createdPrice.id, parseIdempotencyKey("facade:price:retire:0001")),
    ).resolves.toMatchObject({ status: "retired" });
    await expect(
      client.catalog.archiveSku(sku.id, parseIdempotencyKey("facade:sku:archive:0001")),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      client.catalog.archiveProduct(product.id, parseIdempotencyKey("facade:product:archive:0001")),
    ).resolves.toMatchObject({ status: "archived" });
  });
});
