import {
  nativeCapability,
  type ProviderAdapter,
  type ProviderSubscriptionSnapshot,
} from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type Subscription } from "@polybill/core";
import { createMemoryStore } from "@polybill/store-memory";
import {
  createFakeProvider,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "@polybill/testing";
import { vi } from "vitest";
import { createPolybill } from "../src/index.js";
import { subscriptionContext, now, end } from "./subscription-fixtures.js";

export const id = parseId<"SubscriptionId">("sub_canonical", "sub");
export const customerId = parseId<"CustomerId">("cust_canonical", "cust");
export const priceId = parseId<"PriceId">("price_current", "price");
export const nextPriceId = parseId<"PriceId">("price_nextplan", "price");
export const original: Subscription = {
  id,
  customerId,
  status: "active",
  items: [{ priceId, quantity: 2 }],
  currentPeriodEnd: parseIsoDateTime(end),
  version: 1,
};
export const snapshot: ProviderSubscriptionSnapshot = {
  externalId: "remote_sub",
  externalCustomerId: "remote_customer",
  status: "active",
  items: [{ externalPriceId: "remote_price", quantity: 2 }],
  currentPeriodEnd: parseIsoDateTime(end),
  cancelAtPeriodEnd: false,
  rawStatus: "active",
};

export async function setup(
  read: () => ProviderSubscriptionSnapshot | Promise<ProviderSubscriptionSnapshot>,
) {
  const store = createMemoryStore();
  const context = subscriptionContext("fake", async () => {
    throw new Error("No network expected");
  });
  const clock = new VirtualClock(now);
  const base = createFakeProvider();
  const remote = vi.fn(async () => ({
    value: await read(),
    evidence: { provider: "fake" as const, environment: "test" as const, observedAt: clock.now() },
    idempotency: "polybill" as const,
    warnings: [],
  }));
  const adapter: ProviderAdapter = {
    ...base,
    getCapabilities: async (ctx) => ({
      ...(await base.getCapabilities(ctx)),
      capabilities: {
        "subscription.change_items": nativeCapability(),
        "subscription.read": nativeCapability(),
        "subscription.cancel": nativeCapability(),
        "subscription.resume": nativeCapability(),
        "subscription.pause": nativeCapability(),
        "subscription.clear_scheduled_change": nativeCapability(),
        "subscription.set_trial_end": nativeCapability(),
      },
    }),
    subscriptions: {
      get: remote,
      cancel: remote,
      resume: remote,
      changeItems: remote,
      pause: remote,
      clearScheduledChange: remote,
      setTrialEnd: remote,
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
    entityType: "subscription",
    entityId: id,
    externalId: "remote_sub",
    value: original,
    occurredAt: clock.now(),
  });
  const client = createPolybill({
    tenantId: context.tenantId,
    connection: context.connection,
    credentials: {},
    adapter,
    store,
    clock,
    ids: new DeterministicIds(),
    logger: silentLogger,
  });
  return { client, remote, clock, store, context };
}
