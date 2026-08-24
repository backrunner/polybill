import {
  arrayField,
  object,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  parseIsoDateTime,
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
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
  async changeItems(context, externalId, input) {
    assertItemChange(
      context.connection.id,
      input.policy,
      input.items.map((item) => item.externalPriceId),
    );
    const current = await stripeRequest(
      context,
      "GET",
      `/v1/subscriptions/${encodeURIComponent(externalId)}`,
    );
    const body = itemChangeBody(current.json(), input.items, input.policy);
    return stripeResult(
      context,
      decodeSubscription(
        (
          await stripeRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
            body,
          )
        ).json(),
      ),
    );
  },
  async pause(context, externalId, policy) {
    assertPause(context.connection.id, policy);
    return update(
      context,
      externalId,
      new URLSearchParams({ "pause_collection[behavior]": stripePauseBehavior(policy) }),
    );
  },
  async resume(context, externalId) {
    return update(context, externalId, new URLSearchParams({ pause_collection: "" }));
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

async function update(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  body: URLSearchParams,
) {
  return stripeResult(
    context,
    decodeSubscription(
      (
        await stripeRequest(
          context,
          "POST",
          `/v1/subscriptions/${encodeURIComponent(externalId)}`,
          body,
        )
      ).json(),
    ),
  );
}

function itemChangeBody(
  value: unknown,
  desired: readonly { readonly externalPriceId: string; readonly quantity: number }[],
  policy: SubscriptionItemChangePolicy,
): URLSearchParams {
  const root = object(value, "stripe", "stripe.subscription.decode");
  const itemsRoot = object(root.items, "stripe", "stripe.subscription.decode");
  const existing = arrayField(itemsRoot, "data", "stripe", "stripe.subscription.decode").map(
    (entry) => {
      const item = object(entry, "stripe", "stripe.subscription.decode");
      const price = object(item.price, "stripe", "stripe.subscription.decode");
      return {
        id: stringField(item, "id", "stripe", "stripe.subscription.decode"),
        price: stringField(price, "id", "stripe", "stripe.subscription.decode"),
      };
    },
  );
  const desiredByPrice = new Map(desired.map((item) => [item.externalPriceId, item]));
  const body = new URLSearchParams({ proration_behavior: stripeProration(policy.proration) });
  let index = 0;
  for (const item of existing) {
    body.set(`items[${index}][id]`, item.id);
    const replacement = desiredByPrice.get(item.price);
    if (replacement === undefined) body.set(`items[${index}][deleted]`, "true");
    else {
      body.set(`items[${index}][quantity]`, String(replacement.quantity));
      desiredByPrice.delete(item.price);
    }
    index += 1;
  }
  for (const item of desiredByPrice.values()) {
    body.set(`items[${index}][price]`, item.externalPriceId);
    body.set(`items[${index}][quantity]`, String(item.quantity));
    index += 1;
  }
  return body;
}

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
    status:
      root.pause_collection === null || root.pause_collection === undefined
        ? subscriptionStatus(rawStatus)
        : "paused",
    items,
    ...timestamp(root.current_period_start, "currentPeriodStart"),
    ...timestamp(root.current_period_end, "currentPeriodEnd"),
    cancelAtPeriodEnd: root.cancel_at_period_end === true,
    rawStatus,
  };
}

function assertItemChange(
  connectionId: Parameters<typeof unsupported>[0]["connection"]["id"],
  policy: SubscriptionItemChangePolicy,
  priceIds: readonly string[],
): void {
  if (policy.timing !== "immediately")
    throw policyUnsupported(
      connectionId,
      "Stripe period-end item changes require a subscription schedule",
    );
  if (new Set(priceIds).size !== priceIds.length)
    throw policyUnsupported(connectionId, "Stripe item changes require unique prices");
}

function assertPause(
  connectionId: Parameters<typeof unsupported>[0]["connection"]["id"],
  policy: SubscriptionPausePolicy,
): void {
  if (policy.timing !== "immediately" || policy.invoiceBehavior === "stop_billing")
    throw policyUnsupported(
      connectionId,
      "Stripe pause_collection only supports immediate invoice handling and does not stop billing periods",
    );
}

function stripeProration(value: SubscriptionItemChangePolicy["proration"]): string {
  if (value === "none") return "none";
  if (value === "prorate_next_invoice") return "create_prorations";
  return "always_invoice";
}

function stripePauseBehavior(policy: SubscriptionPausePolicy): string {
  if (policy.invoiceBehavior === "void") return "void";
  if (policy.invoiceBehavior === "keep_draft") return "keep_as_draft";
  if (policy.invoiceBehavior === "mark_uncollectible") return "mark_uncollectible";
  throw new TypeError("Stripe stop-billing pause is unsupported");
}

function policyUnsupported(
  connectionId: Parameters<typeof unsupported>[0]["connection"]["id"],
  message: string,
) {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "stripe.subscription.mutate",
    provider: "stripe",
    connectionId,
    retryable: false,
  });
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

function unsupported(
  context: Parameters<NonNullable<SubscriptionProvider["create"]>>[0],
  message: string,
) {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "stripe.subscription.create",
    provider: "stripe",
    connectionId: context.connection.id,
    retryable: false,
  });
}
