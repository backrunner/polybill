import {
  CheckoutService,
  DiscountService,
  type CreateCheckoutCommand,
} from "@polybill/application";
import {
  money,
  parseId,
  parseIdempotencyKey,
  type CommercialPolicy,
  type ConnectionRef,
  type Discount,
  type DiscountId,
  type Price,
} from "@polybill/core";
import { createMemoryStore, MemoryStore } from "@polybill/store-memory";
import { describe, expect, it } from "vitest";
import {
  createFakeProvider,
  createWebCryptoPort,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_000001", "ten");
const price: Price = {
  id: parseId<"PriceId">("price_000001", "price"),
  skuId: parseId<"SkuId">("sku_000001", "sku"),
  version: 1,
  model: { kind: "one_time", unit: money("2500", "USD") },
  taxBehavior: "exclusive",
  status: "active",
  metadata: {},
};

function command(
  key = "checkout:test:0001",
  quantity = 1,
  discountId?: DiscountId,
): CreateCheckoutCommand {
  return {
    idempotencyKey: parseIdempotencyKey(key),
    items: [{ priceId: price.id, quantity }],
    ...(discountId === undefined ? {} : { discountId }),
    successUrl: "https://merchant.example/success",
    cancelUrl: "https://merchant.example/billing",
  };
}

function connection(id: string): ConnectionRef {
  return {
    id: parseId<"ConnectionId">(id, "conn"),
    tenantId,
    provider: "fake",
    environment: "test",
  };
}

function setup(
  adapter = createFakeProvider(),
  store: MemoryStore = createMemoryStore(),
  connectionRef = connection("conn_000001"),
  commercialPolicy?: CommercialPolicy,
  ids: DeterministicIds = new DeterministicIds(),
): { readonly service: CheckoutService; readonly store: MemoryStore } {
  store.seedPrice(tenantId, price);
  return {
    store,
    service: new CheckoutService({
      tenantId,
      connection: connectionRef,
      credentials: {},
      adapter,
      store,
      crypto: createWebCryptoPort(),
      clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
      ids,
      fetch: globalThis.fetch,
      logger: silentLogger,
      ...(commercialPolicy === undefined ? {} : { commercialPolicy }),
    }),
  };
}

describe("checkout application contract", () => {
  it("replays the saved result for the same command", async () => {
    const adapter = createFakeProvider();
    const { service, store } = setup(adapter);
    const first = await service.create(command());
    const second = await service.create(command());

    expect(second).toEqual(first);
    expect(adapter.createCount).toBe(1);
    expect(store.commits).toHaveLength(1);
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const { service } = setup();
    await service.create(command());
    await expect(service.create(command("checkout:test:0001", 2))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("recovers a response-lost mutation without creating twice", async () => {
    const adapter = createFakeProvider({ failAfterCreateOnce: true });
    const { service, store } = setup(adapter);

    await expect(service.create(command())).rejects.toMatchObject({ code: "outcome_unknown" });
    const recovered = await service.create(command());

    expect(recovered.checkout.url).toContain("fake_checkout");
    expect(adapter.createCount).toBe(1);
    expect(store.commits).toHaveLength(1);
  });

  it("fails unsupported capabilities before provider create", async () => {
    const adapter = createFakeProvider({ hostedCheckout: false });
    const { service } = setup(adapter);
    await expect(service.create(command())).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    expect(adapter.createCount).toBe(0);
  });

  it("blocks incompatible commercial responsibility before provider create", async () => {
    const adapter = createFakeProvider({ commercialModel: "payment_processor" });
    const { service } = setup(adapter, createMemoryStore(), connection("conn_000001"), {
      sellerOfRecord: "provider_required",
    });
    await expect(service.create(command())).rejects.toMatchObject({
      code: "commercial_policy_incompatible",
    });
    expect(adapter.createCount).toBe(0);
  });

  it("scopes idempotency and mappings by connection", async () => {
    const store = createMemoryStore();
    const ids = new DeterministicIds();
    const first = setup(
      createFakeProvider({ id: "first" }),
      store,
      connection("conn_000001"),
      undefined,
      ids,
    );
    const second = setup(
      createFakeProvider({ id: "second" }),
      store,
      connection("conn_000002"),
      undefined,
      ids,
    );
    const left = await first.service.create(command());
    const right = await second.service.create(command());

    expect(left.checkout.url).toContain("first");
    expect(right.checkout.url).toContain("second");
    expect(store.commits).toHaveLength(2);
  });

  it("quotes, reserves, and snapshots a mapped canonical discount", async () => {
    const adapter = createFakeProvider({ discount: true });
    const { service, store } = setup(adapter);
    const discount = await createDiscount(store, { maxRedemptions: 1 });
    store.seedMapping(tenantId, connection("conn_000001").id, "discount", discount.id, "promo_10");

    const result = await service.create(command("checkout:discount:0001", 1, discount.id));
    expect(result.order).toMatchObject({
      grossTotal: money("2500", "USD"),
      discountTotal: money("250", "USD"),
      total: money("2250", "USD"),
      discounts: [{ discountId: discount.id, code: "SAVE10", amount: money("250", "USD") }],
    });
    expect(result.payment.amount).toEqual(money("2250", "USD"));
    await expect(
      service.create(command("checkout:discount:0002", 1, discount.id)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(adapter.createCount).toBe(1);
  });

  it("retains a reservation across response loss and finalizes recovery once", async () => {
    const adapter = createFakeProvider({ discount: true, failAfterCreateOnce: true });
    const { service, store } = setup(adapter);
    const discount = await createDiscount(store, { maxRedemptions: 1 });
    store.seedMapping(tenantId, connection("conn_000001").id, "discount", discount.id, "promo_10");
    const discounted = command("checkout:discount:unknown", 1, discount.id);

    await expect(service.create(discounted)).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(service.create(discounted)).resolves.toMatchObject({
      order: { total: money("2250", "USD") },
    });
    expect(adapter.createCount).toBe(1);
    await expect(
      service.create(command("checkout:discount:after-recovery", 1, discount.id)),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("replays an atomic discounted commit after result persistence fails", async () => {
    const adapter = createFakeProvider({ discount: true });
    const store = new FailCompleteOnceStore();
    const { service } = setup(adapter, store);
    const discount = await createDiscount(store, { maxRedemptions: 1 });
    store.seedMapping(tenantId, connection("conn_000001").id, "discount", discount.id, "promo_10");
    const discounted = command("checkout:discount:commit-recovery", 1, discount.id);

    await expect(service.create(discounted)).rejects.toThrow("injected complete failure");
    await expect(service.create(discounted)).resolves.toMatchObject({
      order: { total: money("2250", "USD") },
    });
    expect(adapter.createCount).toBe(1);
    expect(store.commits).toHaveLength(1);
  });

  it("releases an explicitly rejected reservation for a safe retry", async () => {
    const adapter = createFakeProvider({ discount: true, rejectCreateOnce: true });
    const { service, store } = setup(adapter);
    const discount = await createDiscount(store, { maxRedemptions: 1 });
    store.seedMapping(tenantId, connection("conn_000001").id, "discount", discount.id, "promo_10");
    const discounted = command("checkout:discount:retry", 1, discount.id);

    await expect(service.create(discounted)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.create(discounted)).resolves.toMatchObject({
      order: { total: money("2250", "USD") },
    });
    expect(adapter.createCount).toBe(1);
  });

  it("keeps a mismatched provider total unknown without a duplicate create", async () => {
    const adapter = createFakeProvider({
      discount: true,
      mismatchedDiscountTotal: true,
    });
    const { service, store } = setup(adapter);
    const discount = await createDiscount(store);
    store.seedMapping(tenantId, connection("conn_000001").id, "discount", discount.id, "promo_10");
    const discounted = command("checkout:discount:mismatch", 1, discount.id);

    await expect(service.create(discounted)).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(service.create(discounted)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(adapter.createCount).toBe(1);
    expect(store.commits).toHaveLength(0);
  });

  it("rejects discount capability and mapping gaps before provider create", async () => {
    const unsupported = setup(createFakeProvider());
    const discount = await createDiscount(unsupported.store);
    await expect(
      unsupported.service.create(command("checkout:discount:unsupported", 1, discount.id)),
    ).rejects.toMatchObject({ code: "unsupported_capability" });

    const unmapped = setup(createFakeProvider({ discount: true }));
    const unmappedDiscount = await createDiscount(unmapped.store);
    await expect(
      unmapped.service.create(command("checkout:discount:unmapped", 1, unmappedDiscount.id)),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });
});

async function createDiscount(
  store: MemoryStore,
  limits: { readonly maxRedemptions?: number } = {},
): Promise<Discount> {
  return new DiscountService({
    tenantId,
    store,
    crypto: createWebCryptoPort(),
    ids: new DeterministicIds(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  }).create({
    idempotencyKey: parseIdempotencyKey(`discount:create:${limits.maxRedemptions ?? "open"}`),
    code: "SAVE10",
    name: "Save ten percent",
    value: { kind: "percentage", basisPoints: 1_000 },
    ...(limits.maxRedemptions === undefined ? {} : { maxRedemptions: limits.maxRedemptions }),
  });
}

class FailCompleteOnceStore extends MemoryStore {
  #failed = false;

  override async complete(
    ...args: Parameters<MemoryStore["complete"]>
  ): ReturnType<MemoryStore["complete"]> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("injected complete failure");
    }
    return super.complete(...args);
  }
}
