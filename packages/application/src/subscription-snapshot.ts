import {
  assertProviderSubscriptionItems,
  type ProviderOperationResult,
  type ProviderSubscriptionSnapshot,
} from "@polybill/adapter-kit";
import { PolybillError, parseId, type CustomerId, type Subscription } from "@polybill/core";
import { requireExternalId, type ResourceRuntime } from "./resource-runtime.js";
import { validateSubscriptionSnapshot } from "./subscription-validation.js";

export async function saveSubscription(
  runtime: ResourceRuntime,
  id: Subscription["id"],
  customerId: CustomerId,
  remote: ProviderOperationResult<ProviderSubscriptionSnapshot>,
  version: number,
  previous?: Subscription,
): Promise<Subscription> {
  const snapshot = remote.value;
  const value = await projectSubscription(runtime, id, customerId, snapshot, version, previous);
  const commit = {
    tenantId: runtime.options.tenantId,
    connectionId: runtime.options.connection.id,
    provider: runtime.options.connection.provider,
    entityType: "subscription",
    entityId: id,
    externalId: snapshot.externalId,
    value,
    evidence: remote.evidence,
    occurredAt: runtime.options.clock.now(),
  };
  if (version === 1) await runtime.options.store.commitResource(commit);
  else await runtime.options.store.replaceResource({ ...commit, expectedVersion: version - 1 });
  return value;
}

export async function projectSubscription(
  runtime: ResourceRuntime,
  id: Subscription["id"],
  customerId: CustomerId,
  snapshot: ProviderSubscriptionSnapshot,
  version: number,
  previous?: Subscription,
): Promise<Subscription> {
  validateSubscriptionSnapshot(snapshot, runtime.options.connection.provider, previous?.status);
  const customer = await subscriptionMapping(runtime, "customer", customerId);
  if (snapshot.status === "unknown" || snapshot.externalCustomerId !== customer)
    throw new PolybillError(
      "Subscription response does not match the canonical customer or status",
      {
        code: "provider_response_invalid",
        operation: "subscription.decode",
        retryable: false,
      },
    );
  const items = await mapItems(runtime, snapshot.items);
  const scheduled = snapshot.status === "canceled" ? undefined : snapshot.scheduledChange;
  const scheduledItems =
    scheduled?.items === undefined ? undefined : await mapItems(runtime, scheduled.items);
  const accessUntil =
    scheduled?.kind === "cancel"
      ? scheduled.effectiveAt
      : snapshot.cancelAtPeriodEnd && snapshot.status !== "canceled"
        ? snapshot.currentPeriodEnd
        : undefined;
  return {
    id,
    customerId,
    status: snapshot.status,
    items,
    version,
    ...(accessUntil === undefined ? {} : { accessUntil }),
    ...(snapshot.currentPeriodStart === undefined
      ? {}
      : { currentPeriodStart: snapshot.currentPeriodStart }),
    ...(snapshot.currentPeriodEnd === undefined
      ? {}
      : { currentPeriodEnd: snapshot.currentPeriodEnd }),
    ...(scheduled !== undefined
      ? {
          scheduledChange: {
            kind: scheduled.kind,
            effectiveAt: scheduled.effectiveAt,
            ...(scheduledItems === undefined ? {} : { items: scheduledItems }),
          },
        }
      : snapshot.cancelAtPeriodEnd &&
          snapshot.status !== "canceled" &&
          snapshot.currentPeriodEnd !== undefined
        ? {
            scheduledChange: { kind: "cancel", effectiveAt: snapshot.currentPeriodEnd },
          }
        : {}),
    ...(snapshot.collectionPause === undefined
      ? {}
      : { collectionPause: snapshot.collectionPause }),
    ...(snapshot.trialEnd === undefined ? {} : { trialEnd: snapshot.trialEnd }),
    ...(snapshot.resumesAt === undefined ? {} : { resumesAt: snapshot.resumesAt }),
    rawStatus: snapshot.rawStatus,
  };
}

async function mapItems(
  runtime: ResourceRuntime,
  items: ProviderSubscriptionSnapshot["items"],
): Promise<Subscription["items"]> {
  assertProviderSubscriptionItems(items);
  return Promise.all(
    items.map(async (item) => {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1)
        throw new TypeError("Subscription quantity is invalid");
      const id = requireExternalId(
        await runtime.options.store.findCanonicalId(
          runtime.options.tenantId,
          runtime.options.connection.id,
          "price",
          item.externalPriceId,
        ),
        "subscription.price_mapping",
      );
      return {
        priceId: parseId<"PriceId">(id, "price"),
        quantity: item.quantity,
        ...(item.currentPeriodStart === undefined
          ? {}
          : { currentPeriodStart: item.currentPeriodStart }),
        ...(item.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: item.currentPeriodEnd }),
      };
    }),
  );
}

export async function subscriptionMapping(
  runtime: ResourceRuntime,
  type: string,
  id: string,
): Promise<string> {
  return requireExternalId(
    await runtime.options.store.getExternalId(
      runtime.options.tenantId,
      runtime.options.connection.id,
      type,
      id,
    ),
    `subscription.${type}_mapping`,
  );
}
