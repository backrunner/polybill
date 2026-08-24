import {
  arrayField,
  object,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime, type SubscriptionStatus } from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeSubscriptions: SubscriptionProvider = {
  async create(context, input) {
    if (input.trial !== undefined)
      throw unsupported(context, "Trial intervals require an explicit Stripe day-count policy");
    const body = new URLSearchParams({ customer: input.externalCustomerId });
    input.items.forEach((item, index) => {
      body.set(`items[${index}][price]`, item.externalPriceId);
      body.set(`items[${index}][quantity]`, String(item.quantity));
    });
    for (const [key, value] of Object.entries(input.metadata)) body.set(`metadata[${key}]`, value);
    return stripeResult(
      context,
      decodeSubscription((await stripeRequest(context, "POST", "/v1/subscriptions", body)).json()),
    );
  },
  async get(context, externalId) {
    return stripeResult(
      context,
      decodeSubscription(
        (
          await stripeRequest(context, "GET", `/v1/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async cancel(context, externalId, timing) {
    const response =
      timing === "immediately"
        ? await stripeRequest(
            context,
            "DELETE",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
          )
        : await stripeRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
            new URLSearchParams({ cancel_at_period_end: "true" }),
          );
    return stripeResult(context, decodeSubscription(response.json()));
  },
};

function decodeSubscription(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "stripe", "stripe.subscription.decode");
  const rawStatus = stringField(root, "status", "stripe", "stripe.subscription.decode");
  const itemsRoot = object(root.items, "stripe", "stripe.subscription.decode");
  const items = arrayField(itemsRoot, "data", "stripe", "stripe.subscription.decode").map(
    (entry) => {
      const item = object(entry, "stripe", "stripe.subscription.decode");
      const price = object(item.price, "stripe", "stripe.subscription.decode");
      const quantity = item.quantity;
      if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
        throw new TypeError("Stripe subscription quantity is invalid");
      return {
        externalPriceId: stringField(price, "id", "stripe", "stripe.subscription.decode"),
        quantity: Number(quantity),
      };
    },
  );
  return {
    externalId: stringField(root, "id", "stripe", "stripe.subscription.decode"),
    externalCustomerId: stringField(root, "customer", "stripe", "stripe.subscription.decode"),
    status: subscriptionStatus(rawStatus),
    items,
    ...timestamp(root.current_period_start, "currentPeriodStart"),
    ...timestamp(root.current_period_end, "currentPeriodEnd"),
    cancelAtPeriodEnd: root.cancel_at_period_end === true,
    rawStatus,
  };
}

function subscriptionStatus(value: string): SubscriptionStatus | "unknown" {
  if (value === "trialing") return "trialing";
  if (value === "active") return "active";
  if (value === "past_due") return "past_due";
  if (value === "paused") return "paused";
  if (value === "canceled" || value === "unpaid" || value === "incomplete_expired")
    return "canceled";
  if (value === "incomplete") return "incomplete";
  return "unknown";
}

function timestamp(value: unknown, key: "currentPeriodStart" | "currentPeriodEnd") {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? { [key]: parseIsoDateTime(new Date(value * 1000).toISOString()) }
    : {};
}

function unsupported(context: Parameters<SubscriptionProvider["create"]>[0], message: string) {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "stripe.subscription.create",
    provider: "stripe",
    connectionId: context.connection.id,
    retryable: false,
  });
}
