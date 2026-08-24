import { createPolybill } from "../src/index.js";
import { money, parseId, parseIdempotencyKey, type Price } from "@polybill/core";
import { createMemoryStore } from "@polybill/store-memory";
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
});
