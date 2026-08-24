import { readFile } from "node:fs/promises";
import { DiscountService, type IdempotencyScope } from "@polybill/application";
import {
  money,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type CheckoutSession,
  type Order,
  type Payment,
  type Price,
} from "@polybill/core";
import {
  createWebSecretCrypto,
  EntitlementService,
  LicenseService,
  VoucherService,
} from "@polybill/licensing";
import { planMigration } from "@polybill/migration";
import { createWebCryptoPort, DeterministicIds, VirtualClock } from "@polybill/testing";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  D1ApplicationStore,
  D1DiscountStore,
  D1LicensingStore,
  D1MigrationStore,
  D1X402NonceStore,
  D1X402TransactionStore,
  type D1DatabaseLike,
} from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_d1contract", "ten");
const connectionId = parseId<"ConnectionId">("conn_d1contract", "conn");
const now = parseIsoDateTime("2026-08-25T00:00:00.000Z");

describe("D1 control-plane contract", () => {
  let miniflare: Miniflare;
  let db: D1DatabaseLike;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: { DB: "polybill-test" },
    });
    const binding = await miniflare.getD1Database("DB");
    db = binding;
    await binding.exec(await migration("0001_control_plane.sql"));
    await binding.exec(await migration("0002_x402_nonce.sql"));
    await binding.exec(await migration("0003_migration_leases.sql"));
    await binding.exec(await migration("0004_reconciliation_checkpoints.sql"));
    await binding
      .prepare(
        "INSERT INTO polybill_entitlement_policies (tenant_id, policy_id, value) VALUES (?, ?, ?)",
      )
      .bind(
        tenantId,
        "epol_legacy01",
        JSON.stringify({
          id: "epol_legacy01",
          benefit: "legacy:access",
          revokeOn: "never",
          gracePeriodSeconds: 0,
        }),
      )
      .run();
    await binding
      .prepare(
        "INSERT INTO polybill_entitlement_grants (tenant_id, grant_id, source, source_ref, status, value) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        tenantId,
        "grant_legacy01",
        "migration",
        "legacy-record",
        "active",
        JSON.stringify({
          id: "grant_legacy01",
          tenantId,
          policyId: "epol_legacy01",
          source: "migration",
          sourceRef: "legacy-record",
          status: "active",
          grantedAt: now,
        }),
      )
      .run();
    await binding.exec(await migration("0005_entitlements.sql"));
    await binding.exec(await migration("0006_entitlement_beneficiaries.sql"));
    await binding.exec(await migration("0007_discounts.sql"));
    await binding.exec(await migration("0008_discount_redemptions.sql"));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it("upgrades entitlement grants from the previous D1 schema", async () => {
    const grant = await new D1LicensingStore(db).getEntitlementGrant(
      tenantId,
      parseId<"EntitlementGrantId">("grant_legacy01", "grant"),
    );
    expect(grant).toMatchObject({
      policyId: "epol_legacy01",
      beneficiaryRef: "legacy:unassigned",
      status: "active",
      updatedAt: now,
    });
  });

  it("persists idempotency recovery and replays the completed result", async () => {
    let lease = 0;
    const store = new D1ApplicationStore(db, {
      leaseToken: () => `lease_${++lease}`,
    });
    const scope: IdempotencyScope = {
      tenantId,
      connectionId,
      operation: "checkout.create",
      key: parseIdempotencyKey("d1-contract-checkout"),
    };
    const claimed = await store.claim(scope, "payload-a");
    expect(claimed).toEqual({ kind: "claimed", leaseToken: "lease_1" });
    if (claimed.kind !== "claimed") throw new Error("Expected a claimed lease");
    await store.saveRecoveryContext(scope, claimed.leaseToken, { externalReference: "order-1" });
    await store.markUnknown(scope, claimed.leaseToken, "evidence-1");
    await expect(store.claim(scope, "payload-a")).resolves.toMatchObject({
      kind: "outcome_unknown",
      recoveryContext: { externalReference: "order-1" },
    });
    await store.complete(scope, claimed.leaseToken, { checkoutId: "chk_1" });
    await expect(store.claim(scope, "payload-a")).resolves.toEqual({
      kind: "replay",
      result: { checkoutId: "chk_1" },
    });
    await expect(store.claim(scope, "payload-b")).resolves.toEqual({ kind: "conflict" });
  });

  it("reads catalog and commits checkout, order, mapping, and audit atomically", async () => {
    const store = new D1ApplicationStore(db);
    const price = fixturePrice();
    await db
      .prepare(
        "INSERT INTO polybill_catalog_prices (tenant_id, price_id, sku_id, version, value) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(tenantId, price.id, price.skuId, price.version, JSON.stringify(price))
      .run();
    await expect(store.getPrice(tenantId, price.id)).resolves.toEqual(price);

    const checkout: CheckoutSession = {
      id: parseId<"CheckoutId">("chk_d1contract", "chk"),
      orderId: parseId<"OrderId">("ord_d1contract", "ord"),
      status: "open",
      url: "https://checkout.example/session",
    };
    const order = fixtureOrder(checkout.orderId, price);
    const payment: Payment = {
      id: parseId<"PaymentId">("pay_d1contract", "pay"),
      orderId: order.id,
      status: "pending",
      amount: order.total,
      refundedAmount: money("0", "USD"),
      evidence: [],
    };
    const commit = {
      tenantId,
      connectionId,
      provider: "stripe",
      externalCheckoutId: "cs_external",
      checkout,
      order,
      payment,
      evidenceId: parseId<"EvidenceId">("evi_d1contract", "evi"),
      evidence: { requestId: "req_external" },
      occurredAt: now,
    } as const;
    await store.commitCheckout(commit);
    await expect(store.commitCheckout(commit)).resolves.toBeUndefined();
    await expect(store.getCheckout(tenantId, checkout.id)).resolves.toEqual(checkout);
    await expect(store.getResource(tenantId, "payment", payment.id)).resolves.toEqual(payment);
    await expect(
      store.getExternalId(tenantId, connectionId, "checkout", checkout.id),
    ).resolves.toBe("cs_external");
  });

  it("claims a notify nonce and transaction hash exactly once across concurrent callers", async () => {
    const nonces = new D1X402NonceStore(db, {
      tenantId,
      connectionId,
      nowSeconds: () => 1_800_000_000,
    });
    const claims = await Promise.all(
      Array.from({ length: 100 }, () => nonces.putIfAbsent("kid:nonce", 1_800_000_300)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    const transactions = new D1X402TransactionStore(db);
    const first = {
      tenantId,
      connectionId,
      txHash: `0x${"a".repeat(64)}`,
      orderId: "ord_one",
      paymentId: "pay_one",
      observedAt: now,
    };
    await expect(transactions.claim(first)).resolves.toBe("claimed");
    await expect(transactions.claim(first)).resolves.toBe("replay");
    await expect(transactions.claim({ ...first, orderId: "ord_two" })).resolves.toBe("conflict");
  });

  it("atomically enforces a license activation limit under contention", async () => {
    const store = new D1LicensingStore(db);
    const common = {
      store,
      crypto: secretCrypto(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    };
    const entitlements = new EntitlementService(common);
    const service = new LicenseService({
      ...common,
    });
    const policy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "d1-policy-license",
      benefit: "app:licensed",
      revokeOn: "refund",
      gracePeriodSeconds: 0,
    });
    const grant = await entitlements.grant({
      tenantId,
      idempotencyKey: "d1-grant-license",
      policyId: policy.id,
      beneficiaryRef: "customer-d1-license",
      source: "manual",
      sourceRef: "d1-license",
    });
    const issued = await service.issue({
      tenantId,
      grantId: grant.id,
      issuanceKey: "license-issuance-1",
      activationLimit: 1,
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        service.activate({
          tenantId,
          key: issued.key,
          instanceRef: `instance-${index}`,
          deviceFingerprint: `device-${index}`,
        }),
      ),
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  });

  it("persists multi-policy grants and atomic transition idempotency", async () => {
    const service = new EntitlementService({
      store: new D1LicensingStore(db),
      crypto: secretCrypto(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    });
    const policyA = await service.createPolicy({
      tenantId,
      idempotencyKey: "d1-policy-create-a",
      benefit: "app:a",
      revokeOn: "refund",
      gracePeriodSeconds: 0,
    });
    const policyB = await service.createPolicy({
      tenantId,
      idempotencyKey: "d1-policy-create-b",
      benefit: "app:b",
      revokeOn: "never",
      gracePeriodSeconds: 0,
    });
    const grantA = await service.grant({
      tenantId,
      idempotencyKey: "d1-grant-create-a",
      policyId: policyA.id,
      beneficiaryRef: "customer-shared",
      source: "order",
      sourceRef: "shared-order",
    });
    await expect(
      service.grant({
        tenantId,
        idempotencyKey: "d1-grant-create-b",
        policyId: policyB.id,
        beneficiaryRef: "customer-shared",
        source: "order",
        sourceRef: "shared-order",
      }),
    ).resolves.toMatchObject({ policyId: policyB.id });
    const attempts = await Promise.allSettled([
      service.suspend(tenantId, grantA.id, "d1-transition-suspend-a"),
      service.suspend(tenantId, grantA.id, "d1-transition-suspend-b"),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    await expect(service.get(tenantId, grantA.id)).resolves.toMatchObject({
      status: "suspended",
    });
  });

  it("persists isolated and idempotent discount lifecycle operations", async () => {
    const store = new D1DiscountStore(db);
    const service = new DiscountService({
      tenantId,
      store,
      crypto: createWebCryptoPort(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    });
    const command = {
      idempotencyKey: parseIdempotencyKey("d1-discount-create-0001"),
      code: " d1save ",
      name: "D1 save",
      value: { kind: "percentage" as const, basisPoints: 1_500 },
    };
    const created = await service.create(command);
    await expect(service.create({ ...command, code: "D1SAVE" })).resolves.toEqual(created);
    await expect(service.create({ ...command, name: "Changed" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });

    const firstArchiveKey = parseIdempotencyKey("d1-discount-archive-a");
    const secondArchiveKey = parseIdempotencyKey("d1-discount-archive-b");
    const keys = [firstArchiveKey, secondArchiveKey];
    const archived = await Promise.all(keys.map((key) => service.archive(created.id, key)));
    expect(archived).toHaveLength(2);
    expect(archived.every((discount) => discount.status === "archived")).toBe(true);
    await expect(service.archive(created.id, firstArchiveKey)).resolves.toEqual(archived[0]);
    await expect(
      new D1ApplicationStore(db).reserveDiscount({
        tenantId,
        connectionId,
        reservationId: parseId<"DiscountRedemptionId">("dred_archived001", "dred"),
        discountId: created.id,
        idempotencyKey: parseIdempotencyKey("d1-archived-reservation"),
        payloadHash: "archived-payload",
        reservedAt: now,
      }),
    ).resolves.toEqual({ kind: "inactive" });
  });

  it("rejects malformed persisted discounts at the D1 boundary", async () => {
    await db
      .prepare(
        "INSERT INTO polybill_discounts (tenant_id, discount_id, code, status, issuance_key, payload_hash, value) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        tenantId,
        "disc_malformed01",
        "BROKEN",
        "active",
        "d1-malformed-issuance",
        "hash",
        JSON.stringify({ id: "disc_malformed01", code: "BROKEN" }),
      )
      .run();
    await expect(
      new D1DiscountStore(db).getDiscount(
        tenantId,
        parseId<"DiscountId">("disc_malformed01", "disc"),
      ),
    ).rejects.toThrow("Stored D1 discount is invalid");
  });

  it("atomically reserves a globally limited discount under contention", async () => {
    const store = new D1ApplicationStore(db);
    const discount = await new DiscountService({
      tenantId,
      store,
      crypto: createWebCryptoPort(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    }).create({
      idempotencyKey: parseIdempotencyKey("d1-limited-discount-create"),
      code: "LIMITONE",
      name: "Only once",
      value: { kind: "percentage", basisPoints: 1_000 },
      maxRedemptions: 1,
    });
    const attempts = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.reserveDiscount({
          tenantId,
          connectionId,
          reservationId: parseId<"DiscountRedemptionId">(
            `dred_${String(index).padStart(12, "0")}`,
            "dred",
          ),
          discountId: discount.id,
          idempotencyKey: parseIdempotencyKey(
            `d1-discount-reserve-${String(index).padStart(4, "0")}`,
          ),
          payloadHash: `payload-${index}`,
          maxRedemptions: 1,
          reservedAt: now,
        }),
      ),
    );
    expect(attempts.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(attempts.filter((result) => result.kind === "limit_reached")).toHaveLength(99);
  });

  it("atomically finalizes a discount reservation with checkout snapshots", async () => {
    const store = new D1ApplicationStore(db);
    const discount = await new DiscountService({
      tenantId,
      store,
      crypto: createWebCryptoPort(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    }).create({
      idempotencyKey: parseIdempotencyKey("d1-finalize-discount-create"),
      code: "FINALIZE",
      name: "Finalize",
      value: { kind: "fixed", amount: money("500", "USD") },
    });
    const reservationId = parseId<"DiscountRedemptionId">("dred_finalize001", "dred");
    await expect(
      store.reserveDiscount({
        tenantId,
        connectionId,
        reservationId,
        discountId: discount.id,
        idempotencyKey: parseIdempotencyKey("d1-finalize-reservation"),
        payloadHash: "finalize-payload",
        reservedAt: now,
      }),
    ).resolves.toMatchObject({ kind: "reserved" });
    const price = fixturePrice();
    const checkout: CheckoutSession = {
      id: parseId<"CheckoutId">("chk_discountfinal", "chk"),
      orderId: parseId<"OrderId">("ord_discountfinal", "ord"),
      status: "open",
      url: "https://checkout.example/discount",
    };
    const order: Order = {
      ...fixtureOrder(checkout.orderId, price),
      grossTotal: money("2500", "USD"),
      discounts: [{ discountId: discount.id, code: discount.code, amount: money("500", "USD") }],
      discountTotal: money("500", "USD"),
      total: money("2000", "USD"),
    };
    const payment: Payment = {
      id: parseId<"PaymentId">("pay_discountfinal", "pay"),
      orderId: order.id,
      status: "pending",
      amount: order.total,
      refundedAmount: money("0", "USD"),
      evidence: [],
    };
    const commit = {
      tenantId,
      connectionId,
      provider: "stripe" as const,
      externalCheckoutId: "cs_discount_final",
      checkout,
      order,
      payment,
      evidenceId: parseId<"EvidenceId">("evi_discountfinal", "evi"),
      evidence: { requestId: "req_discount_final" },
      occurredAt: now,
      discountReservationId: reservationId,
    };
    await expect(
      store.commitCheckout({
        ...commit,
        connectionId: parseId<"ConnectionId">("conn_wrongfinal", "conn"),
      }),
    ).rejects.toThrow("Discounted checkout commit was not atomic");
    await expect(store.getResource<Order>(tenantId, "order", order.id)).resolves.toBeUndefined();
    await store.commitCheckout(commit);
    await expect(store.commitCheckout(commit)).resolves.toBeUndefined();
    await expect(store.getResource<Order>(tenantId, "order", order.id)).resolves.toEqual(order);
    const row = await db
      .prepare(
        "SELECT status, order_id FROM polybill_discount_redemptions WHERE tenant_id = ? AND redemption_id = ?",
      )
      .bind(tenantId, reservationId)
      .first<{ status: string; order_id: string }>();
    expect(row).toEqual({ status: "finalized", order_id: order.id });
  });

  it("atomically redeems a single-use voucher once under contention", async () => {
    const store = new D1LicensingStore(db);
    const common = {
      store,
      crypto: secretCrypto(),
      ids: new DeterministicIds(),
      clock: new VirtualClock(now),
    };
    const entitlements = new EntitlementService(common);
    const service = new VoucherService(common);
    const policy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "d1-policy-voucher",
      benefit: "app:voucher-access",
      revokeOn: "never",
      gracePeriodSeconds: 0,
    });
    const created = await service.createBatch({
      tenantId,
      issuanceKey: "voucher-issuance-1",
      prefix: "GIFT",
      quantity: 1,
      maxUses: 1,
      benefit: {
        kind: "entitlement",
        policyId: policy.id,
      },
    });
    const code = created.codes[0];
    if (code === undefined) throw new Error("Expected an issued voucher code");
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        service.redeem({
          tenantId,
          code,
          idempotencyKey: `voucher-redeem-${index}`,
          beneficiaryRef: `customer-${index}`,
        }),
      ),
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const successful = attempts.find((item) => item.status === "fulfilled");
    if (successful?.status !== "fulfilled") throw new Error("Expected successful redemption");
    await expect(
      service.redeemWithBenefit({
        tenantId,
        code,
        idempotencyKey: successful.value.idempotencyKey,
        beneficiaryRef: successful.value.beneficiaryRef,
      }),
    ).resolves.toMatchObject({
      entitlementGrant: {
        policyId: policy.id,
        beneficiaryRef: successful.value.beneficiaryRef,
        sourceRef: successful.value.id,
      },
    });
  });

  it("leases migration items, resumes stale work, and keeps checkpoints monotonic", async () => {
    let time = 100;
    let lease = 0;
    const store = new D1MigrationStore(db, tenantId, {
      now: () => time,
      leaseMs: 10,
      leaseToken: () => `migration-lease-${++lease}`,
    });
    const capabilities = {
      provider: "stripe" as const,
      adapterVersion: "0.1.0",
      providerApiVersion: "fixture-v1",
      capabilities: {},
      commercialTerms: {
        model: "payment_processor" as const,
        sellerOfRecord: "merchant" as const,
        taxCalculation: "merchant" as const,
        taxInvoiceIssuer: "merchant" as const,
        disputeResponsibility: "merchant" as const,
        observedAt: now,
        evidenceRef: parseId<"EvidenceId">("evi_migration", "evi"),
      },
      observedAt: now,
    };
    const plan = await planMigration({
      id: "migration-d1",
      tenantId,
      sourceConnectionId: connectionId,
      targetConnectionId: parseId<"ConnectionId">("conn_target", "conn"),
      mode: "observe_only",
      sourceCapabilities: capabilities,
      targetCapabilities: capabilities,
      items: [{ key: "payment", entityType: "payment", sourceId: "pay_source", payload: {} }],
      createdAt: now,
    });
    await store.savePlan(plan);
    await expect(store.getPlan(plan.id)).resolves.toEqual(plan);

    const first = await store.claimItem(plan.id, "payment");
    expect(first).toEqual({ kind: "claimed", leaseToken: "migration-lease-1" });
    await expect(store.claimItem(plan.id, "payment")).resolves.toEqual({ kind: "in_progress" });
    time = 111;
    const resumed = await store.claimItem(plan.id, "payment");
    expect(resumed).toEqual({ kind: "claimed", leaseToken: "migration-lease-3" });
    if (resumed.kind !== "claimed") throw new Error("Expected the stale lease to be reclaimed");
    await store.completeItem(plan.id, resumed.leaseToken, {
      itemKey: "payment",
      status: "mapped",
    });
    await expect(store.listResults(plan.id)).resolves.toEqual([
      { itemKey: "payment", status: "mapped" },
    ]);

    await store.saveCheckpoint(plan.id, "payments", "later", 2);
    await store.saveCheckpoint(plan.id, "payments", "earlier", 1);
    await expect(store.getCheckpoint(plan.id, "payments")).resolves.toEqual({
      cursor: "later",
      sequence: 2,
    });
    await store.setRouting("shadow_read", plan.id);
    await expect(store.getRouting()).resolves.toEqual({ mode: "shadow_read", planId: plan.id });
  });

  it("pages reconciliation mappings and keeps its checkpoint monotonic", async () => {
    const store = new D1ApplicationStore(db);
    await store.commitResource({
      tenantId,
      connectionId,
      provider: "stripe",
      entityType: "customer",
      entityId: "cust_reconcile01",
      externalId: "cus_external",
      value: { id: "cust_reconcile01", externalId: "host-customer", status: "active" },
      occurredAt: now,
    });
    await expect(
      store.listReconciliationTargets({ tenantId, connectionId, limit: 10 }),
    ).resolves.toMatchObject({
      items: [{ entityType: "customer", entityId: "cust_reconcile01", externalId: "cus_external" }],
      nextCursor: "customer:cust_reconcile01",
    });
    await store.saveReconciliationCheckpoint({
      tenantId,
      connectionId,
      stream: "mutable",
      cursor: "customer:cust_reconcile01",
      sequence: 2,
      observedAt: now,
    });
    await store.saveReconciliationCheckpoint({
      tenantId,
      connectionId,
      stream: "mutable",
      cursor: "older",
      sequence: 1,
      observedAt: now,
    });
    await expect(
      store.getReconciliationCheckpoint({ tenantId, connectionId, stream: "mutable" }),
    ).resolves.toEqual({ cursor: "customer:cust_reconcile01", sequence: 2 });
  });
});

function fixturePrice(): Price {
  return {
    id: parseId<"PriceId">("price_d1contract", "price"),
    skuId: parseId<"SkuId">("sku_d1contract", "sku"),
    version: 1,
    model: { kind: "one_time", unit: money("2500", "USD") },
    taxBehavior: "exclusive",
    status: "active",
    metadata: {},
  };
}

function fixtureOrder(id: Order["id"], price: Price): Order {
  return {
    id,
    lines: [
      {
        skuId: price.skuId,
        priceId: price.id,
        price: price.model,
        quantity: 1,
        subtotal: money("2500", "USD"),
      },
    ],
    grossTotal: money("2500", "USD"),
    discounts: [],
    discountTotal: money("0", "USD"),
    total: money("2500", "USD"),
    paymentStatus: "pending",
    fulfillmentStatus: "unfulfilled",
    commercialTermsRef: parseId<"EvidenceId">("evi_terms0001", "evi"),
    createdAt: now,
  };
}

async function migration(name: string): Promise<string> {
  const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  return source
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`)
    .join("\n");
}

function secretCrypto() {
  return createWebSecretCrypto({
    digestKey: new Uint8Array(32).fill(11),
    activeEncryptionKeyId: "test-key",
    encryptionKeys: { "test-key": new Uint8Array(32).fill(12) },
  });
}
