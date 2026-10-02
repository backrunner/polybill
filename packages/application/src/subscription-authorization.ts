import {
  PolybillError,
  parseId,
  type CheckoutId,
  type Order,
  type Subscription,
} from "@polybill/core";
import type { ResourceRuntime } from "./resource-runtime.js";
import {
  projectSubscription,
  saveSubscription,
  subscriptionMapping,
} from "./subscription-snapshot.js";

export type SubscriptionAuthorization =
  | {
      readonly checkoutId: CheckoutId;
      readonly status: "pending" | "failed" | "expired" | "not_recurring";
    }
  | {
      readonly checkoutId: CheckoutId;
      readonly status: "bound";
      readonly subscriptions: readonly Subscription[];
    };

/** May be polled or called after a verified webhook. No provider mutation or payment grant. */
export class SubscriptionAuthorizationService {
  constructor(readonly runtime: ResourceRuntime) {}

  async refresh(checkoutId: CheckoutId): Promise<SubscriptionAuthorization> {
    parseId<"CheckoutId">(checkoutId, "chk");
    const { store, tenantId, connection, adapter, crypto } = this.runtime.options;
    const context = await this.runtime.context();
    await this.runtime.requireCapability("subscription.bind_checkout", context);
    const checkout = await store.getCheckout(tenantId, checkoutId);
    if (checkout === undefined) throw failure("not_found");
    const externalId = await subscriptionMapping(this.runtime, "checkout", checkoutId);
    const order = await store.getResource<Order>(tenantId, "order", checkout.orderId);
    if (
      order === undefined ||
      adapter.checkout === undefined ||
      adapter.subscriptions?.get === undefined
    )
      throw failure("not_found");
    if (!order.lines.some((line) => ["recurring", "seat", "metered"].includes(line.price.kind)))
      return { checkoutId, status: "not_recurring" };
    if (order.customerId === undefined) throw failure("invalid_request");
    await subscriptionMapping(this.runtime, "customer", order.customerId);
    const remote = (await adapter.checkout.get(context, externalId)).value;
    if (remote.externalId !== externalId || remote.status === "unknown")
      throw failure("provider_response_invalid");
    if (remote.status === "expired") return { checkoutId, status: "expired" };
    if (remote.status === "canceled") return { checkoutId, status: "failed" };
    const ids = remote.externalSubscriptionIds ?? [];
    if (remote.status !== "complete" || ids.length === 0) return { checkoutId, status: "pending" };
    if (
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || id.length === 0)
    )
      throw failure("provider_response_invalid");
    const subscriptions: Subscription[] = [];
    for (const externalSubscriptionId of ids) {
      const mapped = await store.findCanonicalId(
        tenantId,
        connection.id,
        "subscription",
        externalSubscriptionId,
      );
      const digest = await crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify([tenantId, connection.id, connection.environment, externalSubscriptionId]),
        ),
      );
      const id = parseId<"SubscriptionId">(mapped ?? `sub_${digest}`, "sub");
      const previous = await store.getResource<Subscription>(tenantId, "subscription", id);
      if (previous !== undefined && previous.customerId !== order.customerId)
        throw failure("provider_response_invalid");
      const observed = await adapter.subscriptions.get(context, externalSubscriptionId);
      if (observed.value.externalId !== externalSubscriptionId)
        throw failure("provider_response_invalid");
      if (previous !== undefined) {
        subscriptions.push(
          await saveSubscription(
            this.runtime,
            id,
            order.customerId,
            observed,
            previous.version + 1,
            previous,
          ),
        );
      } else {
        const value = await projectSubscription(
          this.runtime,
          id,
          order.customerId,
          observed.value,
          1,
        );
        await store.insertResource({
          tenantId,
          connectionId: connection.id,
          provider: connection.provider,
          entityType: "subscription",
          entityId: id,
          externalId: externalSubscriptionId,
          value,
          evidence: observed.evidence,
          occurredAt: context.clock.now(),
        });
        const saved = await store.getResource<Subscription>(tenantId, "subscription", id);
        if (saved === undefined || saved.customerId !== order.customerId)
          throw failure("provider_response_invalid");
        subscriptions.push(saved);
      }
    }
    return { checkoutId, status: "bound", subscriptions };
  }
}

function failure(code: "not_found" | "invalid_request" | "provider_response_invalid") {
  return new PolybillError(
    "Subscription authorization requires a scoped checkout, mapped customer and authoritative subscription references",
    {
      code,
      operation: "subscription.bind_checkout",
      retryable: false,
    },
  );
}
