import {
  createHttpTransport,
  type ProviderAdapter,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { CheckoutService, ResourceRuntime } from "@polybill/application";
import { money, parseId, parseIdempotencyKey, PolybillError, type Price } from "@polybill/core";
import { createMemoryStore, MemoryStore } from "@polybill/store-memory";
import { describe, expect, it, vi } from "vitest";
import {
  createFakeProvider,
  createWebCryptoPort,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_safety01", "ten");
const connection = {
  tenantId,
  id: parseId<"ConnectionId">("conn_safety01", "conn"),
  provider: "fake",
  environment: "test",
} as const;
const price: Price = {
  id: parseId<"PriceId">("price_safety01", "price"),
  skuId: parseId<"SkuId">("sku_safety01", "sku"),
  version: 1,
  model: { kind: "one_time", unit: money("2500", "USD") },
  taxBehavior: "exclusive",
  status: "active",
  metadata: {},
};
const key = parseIdempotencyKey("review:mutation:01");

function options(
  adapter: ProviderAdapter,
  fetch: typeof globalThis.fetch,
  store = createMemoryStore(),
) {
  store.seedPrice(tenantId, price);
  return {
    tenantId,
    connection,
    adapter,
    credentials: {},
    store,
    fetch,
    clock: new VirtualClock("2026-09-06T00:00:00.000Z"),
    crypto: createWebCryptoPort(),
    ids: new DeterministicIds(),
    logger: silentLogger,
  };
}

async function send(context: ProviderContext) {
  return createHttpTransport({ provider: "fake", fetch: context.fetch }).send({
    method: "POST",
    url: "https://provider.example/create",
  });
}

describe("mutation outcome safety", () => {
  it("rejects reusing a connection ID for live credentials before replay or transport", async () => {
    const store = createMemoryStore();
    const adapter = createFakeProvider();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const test = new CheckoutService(options(adapter, fetch, store));
    const command = {
      idempotencyKey: key,
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    };
    await test.create(command);
    const live = new CheckoutService({
      ...options(adapter, fetch, store),
      connection: { ...connection, environment: "live" },
    });
    await expect(live.create(command)).rejects.toMatchObject({
      code: "conflict",
      operation: "connection.bind",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["catalog", "ad_hoc"])(
    "retains the claim after a %s checkout JSON failure",
    async (kind) => {
      const base = createFakeProvider();
      const fetch = vi.fn(async () => new Response("{truncated"));
      const adapter: ProviderAdapter = {
        ...base,
        checkout: {
          create: async (context) => {
            (await send(context)).json();
            throw new Error("unreachable");
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      };
      const service = new CheckoutService(options(adapter, fetch));
      const common = {
        idempotencyKey: key,
        successUrl: "https://merchant.example/success",
        cancelUrl: "https://merchant.example/cancel",
      };
      const create = () =>
        kind === "catalog"
          ? service.create({ ...common, items: [{ priceId: price.id, quantity: 1 }] })
          : service.createAdHoc({
              ...common,
              items: [
                { skuId: price.skuId, price: price.model, quantity: 1, persistence: "session" },
              ],
            });
      await expect(create()).rejects.toMatchObject({ code: "provider_response_invalid" });
      await expect(create()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps completed checkout and payment finality independent", async () => {
    const base = createFakeProvider();
    const create = base.checkout?.create;
    if (create === undefined) throw new Error("fixture checkout missing");
    const adapter: ProviderAdapter = {
      ...base,
      checkout: {
        ...base.checkout,
        get: async () => {
          throw new Error("unused");
        },
        create: async (context, command) => {
          const result = await create(context, command);
          return { ...result, value: { ...result.value, status: "complete" } };
        },
      },
    };
    const service = new CheckoutService(options(adapter, vi.fn()));
    const result = await service.create({
      idempotencyKey: key,
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });
    expect(result.checkout.status).toBe("complete");
    expect(result.payment).toMatchObject({ status: "pending", evidence: [] });
    expect(result.order.paymentStatus).toBe("pending");
  });

  it("does not release an earlier side effect when a later request is rejected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "created" }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    const runtime = new ResourceRuntime(options(createFakeProvider(), fetch));
    const mutate = () =>
      runtime.mutate({
        operation: "customer.create",
        key,
        payload: {},
        decodeReplay: () => undefined,
        execute: async (context) => {
          await send(context);
          await send(context);
          throw new PolybillError("Rejected", {
            code: "invalid_request",
            operation: "fixture",
            retryable: false,
          });
        },
      });
    await expect(mutate()).rejects.toMatchObject({ code: "invalid_request" });
    await expect(mutate()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains a resource mutation after local result persistence fails", async () => {
    class FailingStore extends MemoryStore {
      override async complete(): Promise<void> {
        throw new Error("store unavailable");
      }
    }
    const fetch = vi.fn(async () => Response.json({ id: "created" }));
    const runtime = new ResourceRuntime(options(createFakeProvider(), fetch, new FailingStore()));
    const mutate = () =>
      runtime.mutate({
        operation: "customer.create",
        key,
        payload: {},
        decodeReplay: () => undefined,
        execute: async (context) => {
          await send(context);
        },
      });
    await expect(mutate()).rejects.toThrow("store unavailable");
    await expect(mutate()).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
