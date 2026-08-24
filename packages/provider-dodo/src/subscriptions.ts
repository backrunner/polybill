import {
  object,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  parseIsoDateTime,
  type ConnectionId,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { dodoRequest } from "./client.js";
import { dodoResult } from "./result.js";

export const dodoSubscriptions: SubscriptionProvider = {
  async get(context, externalId) {
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async cancel(context, externalId, timing) {
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(
            context,
            "PATCH",
            `/subscriptions/${encodeURIComponent(externalId)}`,
            timing === "immediately"
              ? { status: "cancelled", cancel_reason: "cancelled_by_merchant" }
              : { cancel_at_next_billing_date: true },
          )
        ).json(),
      ),
    );
  },
  async pause(context, externalId, policy) {
    assertPausePolicy(context.connection.id, policy);
    return lifecycle(context, externalId, "paused");
  },
  async resume(context, externalId) {
    return lifecycle(context, externalId, "active");
  },
};

async function lifecycle(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  status: "paused" | "active",
) {
  return dodoResult(
    context,
    decode(
      (
        await dodoRequest(context, "PATCH", `/subscriptions/${encodeURIComponent(externalId)}`, {
          status,
        })
      ).json(),
    ),
  );
}

function assertPausePolicy(connectionId: ConnectionId, policy: SubscriptionPausePolicy): void {
  if (policy.timing !== "immediately" || policy.invoiceBehavior !== "stop_billing")
    throw new PolybillError("Dodo only supports an immediate stop-billing pause", {
      code: "unsupported_capability",
      operation: "dodo.subscription.pause",
      provider: "dodo",
      connectionId,
      retryable: false,
    });
}

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "dodo", "dodo.subscription.decode");
  const rawStatus = stringField(root, "status", "dodo", "dodo.subscription.decode");
  const customer = object(root.customer, "dodo", "dodo.subscription.decode");
  const quantity = root.quantity;
  if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
    throw new TypeError("Dodo subscription quantity is invalid");
  return {
    externalId: stringField(root, "subscription_id", "dodo", "dodo.subscription.decode"),
    externalCustomerId: stringField(customer, "customer_id", "dodo", "dodo.subscription.decode"),
    status: canonicalStatus(rawStatus),
    items: [
      {
        externalPriceId: stringField(root, "product_id", "dodo", "dodo.subscription.decode"),
        quantity: Number(quantity),
      },
    ],
    currentPeriodStart: parseIsoDateTime(
      stringField(root, "previous_billing_date", "dodo", "dodo.subscription.decode"),
    ),
    currentPeriodEnd: parseIsoDateTime(
      stringField(root, "next_billing_date", "dodo", "dodo.subscription.decode"),
    ),
    cancelAtPeriodEnd: root.cancel_at_next_billing_date === true,
    rawStatus,
  };
}

function canonicalStatus(value: string): SubscriptionStatus | "unknown" {
  if (["active", "paused", "past_due", "unpaid", "trialing"].includes(value))
    return value as SubscriptionStatus;
  if (["cancelled", "canceled", "expired", "failed"].includes(value)) return "canceled";
  if (["pending", "on_hold"].includes(value)) return "incomplete";
  return "unknown";
}
