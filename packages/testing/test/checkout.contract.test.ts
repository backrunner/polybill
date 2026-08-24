import { CheckoutService, type CreateCheckoutCommand } from "@polybill/application";
import {
  money,
  parseId,
  parseIdempotencyKey,
  type CommercialPolicy,
  type ConnectionRef,
  type Price,
} from "@polybill/core";
import { createMemoryStore, type MemoryStore } from "@polybill/store-memory";
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

function command(key = "checkout:test:0001", quantity = 1): CreateCheckoutCommand {
  return {
    idempotencyKey: parseIdempotencyKey(key),
    items: [{ priceId: price.id, quantity }],
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
});
