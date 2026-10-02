import {
  nativeCapability,
  type ProviderAdapter,
  type ProviderCheckoutSnapshot,
  type ProviderContext,
  type ProviderSubscriptionSnapshot,
} from "@polybill/adapter-kit";
import { PolybillError, money, parseId, type Subscription } from "@polybill/core";
import {
  CreditService,
  SubscriptionScheduleService,
  ResourceRuntime,
  UsageService,
} from "@polybill/application";
import { createMemoryStore, MemoryBillingStore } from "@polybill/store-memory";
import {
  createFakeProvider,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "@polybill/testing";
import { vi } from "vitest";
import { createPolybill } from "../src/index.js";
import { subscriptionContext, now } from "./subscription-fixtures.js";
export { customerId, id, priceId, nextPriceId, snapshot } from "./subscription-state-fixture.js";
import {
  customerId,
  id,
  original,
  priceId,
  nextPriceId,
  snapshot,
} from "./subscription-state-fixture.js";

export async function billingFixture(
  billing = new MemoryBillingStore(),
  existingSubscription = true,
) {
  const context = subscriptionContext("fake", async () => {
    throw new Error("No network expected");
  });
  const clock = new VirtualClock(now);
  const store = createMemoryStore();
  let remote: ProviderSubscriptionSnapshot = globalThis.structuredClone(snapshot);
  let checkoutStatus: ProviderCheckoutSnapshot["status"] = "open";
  let lost = false;
  const base = createFakeProvider();
  const result = <T>(value: T) => ({
    value,
    evidence: { provider: "fake" as const, environment: "test" as const, observedAt: clock.now() },
    idempotency: "polybill" as const,
    warnings: [],
  });
  const mutate = vi.fn(
    async (
      _ctx: ProviderContext,
      _id: string,
      input: { items: ProviderSubscriptionSnapshot["items"] },
    ) => {
      remote = { ...remote, items: input.items };
      if (lost)
        throw new PolybillError("Lost response", {
          code: "outcome_unknown",
          operation: "subscription.change_items",
          retryable: false,
        });
      return result(remote);
    },
  );
  let accepted = false;
  const ingest = vi.fn(async () => {
    accepted = true;
    if (lost) throw new Error("Response lost");
  });
  const adapter: ProviderAdapter = {
    ...base,
    getCapabilities: async (ctx) => ({
      ...(await base.getCapabilities(ctx)),
      capabilities: {
        "checkout.hosted": nativeCapability(),
        "subscription.read": nativeCapability(),
        "subscription.change_items": nativeCapability(),
        "subscription.bind_checkout": nativeCapability(),
        "usage.meter": nativeCapability(),
        "usage.ingest": nativeCapability(),
      },
    }),
    checkout: {
      create: async (_ctx, command) => {
        if (command.externalCustomerId !== "remote_customer")
          throw new Error("Mapped customer not passed to checkout");
        return result({
          externalId: "remote_checkout",
          status: "open" as const,
          rawStatus: "open",
        });
      },
      get: async () =>
        result({
          externalId: "remote_checkout",
          status: checkoutStatus,
          rawStatus: checkoutStatus,
          externalSubscriptionIds: checkoutStatus === "complete" ? ["remote_sub"] : [],
        }),
    },
    subscriptions: { get: async () => result(remote), changeItems: mutate },
    usage: {
      createMeter: async () => result({ externalId: "remote_meter" }),
      ingest,
      findEvent: async () => accepted,
    },
  };
  await store.bindConnection(context.connection);
  store.seedMapping(
    context.tenantId,
    context.connection.id,
    "customer",
    customerId,
    "remote_customer",
  );
  store.seedMapping(context.tenantId, context.connection.id, "price", priceId, "remote_price");
  store.seedMapping(
    context.tenantId,
    context.connection.id,
    "price",
    nextPriceId,
    "remote_next_price",
  );
  await store.commitResource({
    tenantId: context.tenantId,
    connectionId: context.connection.id,
    provider: "fake",
    entityType: "customer",
    entityId: customerId,
    externalId: "remote_customer",
    value: { id: customerId, externalId: "host_customer", status: "active" },
    occurredAt: clock.now(),
  });
  if (existingSubscription)
    await store.commitResource({
      tenantId: context.tenantId,
      connectionId: context.connection.id,
      provider: "fake",
      entityType: "subscription",
      entityId: id,
      externalId: "remote_sub",
      value: original,
      occurredAt: clock.now(),
    });
  store.seedPrice(context.tenantId, {
    id: priceId,
    skuId: parseId<"SkuId">("sku_fixture", "sku"),
    version: 1,
    status: "active",
    taxBehavior: "unspecified",
    metadata: {},
    model: { kind: "recurring", unit: money("100", "USD"), interval: { unit: "month", count: 1 } },
  });
  const options = {
    tenantId: context.tenantId,
    connection: context.connection,
    credentials: {},
    adapter,
    store,
    billing: { store: billing },
    clock,
    ids: new DeterministicIds(),
    logger: silentLogger,
    crypto: context.crypto,
    fetch: context.fetch,
  };
  const runtime = new ResourceRuntime(options);
  return {
    store,
    billing,
    clock,
    context,
    runtime,
    client: createPolybill(options),
    mutate,
    ingest,
    schedules: new SubscriptionScheduleService(runtime, billing),
    credits: new CreditService(runtime, billing),
    usage: new UsageService(runtime, billing),
    setLost(value: boolean) {
      lost = value;
    },
    setRemote(value: ProviderSubscriptionSnapshot) {
      remote = value;
    },
    setCheckout(value: ProviderCheckoutSnapshot["status"]) {
      checkoutStatus = value;
    },
    getSubscription(subscriptionId = id) {
      return store.getResource<Subscription>(context.tenantId, "subscription", subscriptionId);
    },
  };
}
