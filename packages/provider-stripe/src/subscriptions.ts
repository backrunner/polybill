import {
  arrayField,
  assertProviderSubscriptionItems,
  assertSubscriptionIdentity,
  object,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  assertFutureSubscriptionDate,
  assertSubscriptionPausePolicy,
  assertSubscriptionItemChangePolicy,
  validateBillingInterval,
  parseIsoDateTime,
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";
import { completeStripeSubscription } from "./subscription-items.js";

export const stripeSubscriptions: SubscriptionProvider = {
  async create(context, input) {
    assertProviderSubscriptionItems(input.items);
    const body = new URLSearchParams({ customer: input.externalCustomerId });
    if (input.trial !== undefined) {
      validateBillingInterval(input.trial);
      if (input.trial.unit !== "day" && input.trial.unit !== "week")
        throw unsupported(context, "Stripe trial creation requires a day or week interval");
      const days = input.trial.count * (input.trial.unit === "week" ? 7 : 1);
      if (days > 730) throw unsupported(context, "Stripe trials cannot exceed 730 days");
      body.set("trial_period_days", String(days));
    }
    input.items.forEach((item, index) => {
      body.set(`items[${index}][price]`, item.externalPriceId);
      body.set(`items[${index}][quantity]`, String(item.quantity));
    });
    for (const [key, value] of Object.entries(input.metadata)) body.set(`metadata[${key}]`, value);
    return stripeResult(
      context,
      await decodeResponse(
        context,
        (await stripeRequest(context, "POST", "/v1/subscriptions", body)).json(),
      ),
    );
  },
  async get(context, externalId) {
    return stripeResult(
      context,
      await decodeResponse(
        context,
        (
          await stripeRequest(context, "GET", `/v1/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
        externalId,
      ),
    );
  },
  async changeItems(context, externalId, input) {
    assertProviderSubscriptionItems(input.items);
    assertSubscriptionItemChangePolicy(input.policy);
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
    const complete = await completeStripeSubscription(context, current.json(), externalId);
    const body = itemChangeBody(complete, input.items, input.policy);
    return stripeResult(
      context,
      await decodeResponse(
        context,
        (
          await stripeRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
            body,
          )
        ).json(),
        externalId,
      ),
    );
  },
  async pause(context, externalId, policy) {
    assertSubscriptionPausePolicy(policy, context.clock.now());
    assertPause(context.connection.id, policy);
    const body = new URLSearchParams({ "pause_collection[behavior]": stripePauseBehavior(policy) });
    if (policy.resumesAt !== undefined)
      body.set(
        "pause_collection[resumes_at]",
        String(Math.floor(Date.parse(policy.resumesAt) / 1000)),
      );
    return update(context, externalId, body);
  },
  async resume(context, externalId) {
    const current = object(
      (
        await stripeRequest(context, "GET", `/v1/subscriptions/${encodeURIComponent(externalId)}`)
      ).json(),
      "stripe",
      "stripe.subscription.read",
    );
    assertSubscriptionIdentity(current.id, externalId, "stripe");
    if (current.status === "paused")
      return stripeResult(
        context,
        await decodeResponse(
          context,
          (
            await stripeRequest(
              context,
              "POST",
              `/v1/subscriptions/${encodeURIComponent(externalId)}/resume`,
              new URLSearchParams({ billing_cycle_anchor: "now", proration_behavior: "none" }),
            )
          ).json(),
          externalId,
        ),
      );
    return update(context, externalId, new URLSearchParams({ pause_collection: "" }));
  },
  async clearScheduledChange(context, externalId, kind) {
    if (kind !== "cancel")
      throw unsupported(context, "This Stripe operation clears a pending cancellation only");
    return update(
      context,
      externalId,
      new URLSearchParams({ cancel_at_period_end: "false", cancel_at: "" }),
    );
  },
  async setTrialEnd(context, externalId, end) {
    if (end !== "now") assertFutureSubscriptionDate(end, context.clock.now());
    return update(
      context,
      externalId,
      new URLSearchParams({
        trial_end: end === "now" ? "now" : String(Math.floor(Date.parse(end) / 1000)),
      }),
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
    return stripeResult(context, await decodeResponse(context, response.json(), externalId));
  },
};

async function update(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  body: URLSearchParams,
) {
  return stripeResult(
    context,
    await decodeResponse(
      context,
      (
        await stripeRequest(
          context,
          "POST",
          `/v1/subscriptions/${encodeURIComponent(externalId)}`,
          body,
        )
      ).json(),
      externalId,
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

async function decodeResponse(
  context: Parameters<typeof stripeRequest>[0],
  value: unknown,
  expectedId?: string,
): Promise<ProviderSubscriptionSnapshot> {
  return decodeSubscription(await completeStripeSubscription(context, value, expectedId));
}

function decodeSubscription(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "stripe", "stripe.subscription.decode");
  const rawStatus = stringField(root, "status", "stripe", "stripe.subscription.decode");
  const itemsRoot = object(root.items, "stripe", "stripe.subscription.decode");
  const entries = arrayField(itemsRoot, "data", "stripe", "stripe.subscription.decode");
  const items = entries.map((entry) => {
    const item = object(entry, "stripe", "stripe.subscription.decode");
    const price = object(item.price, "stripe", "stripe.subscription.decode");
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
      throw new TypeError("Stripe subscription quantity is invalid");
    return {
      externalPriceId: stringField(price, "id", "stripe", "stripe.subscription.decode"),
      quantity: Number(quantity),
      ...timestamp(item.current_period_start, "currentPeriodStart"),
      ...timestamp(item.current_period_end, "currentPeriodEnd"),
    };
  });
  return {
    externalId: stringField(root, "id", "stripe", "stripe.subscription.decode"),
    externalCustomerId: stringField(root, "customer", "stripe", "stripe.subscription.decode"),
    status: subscriptionStatus(rawStatus),
    items,
    ...timestamp(
      root.current_period_start ?? commonPeriod(entries, "current_period_start"),
      "currentPeriodStart",
    ),
    ...timestamp(
      root.current_period_end ?? commonPeriod(entries, "current_period_end"),
      "currentPeriodEnd",
    ),
    cancelAtPeriodEnd: root.cancel_at_period_end === true,
    ...(typeof root.cancel_at === "number" &&
    rawStatus !== "canceled" &&
    rawStatus !== "incomplete_expired"
      ? {
          scheduledChange: {
            kind: "cancel" as const,
            effectiveAt: parseIsoDateTime(new Date(root.cancel_at * 1000).toISOString()),
          },
        }
      : {}),
    ...collectionPause(root.pause_collection),
    ...(typeof root.trial_end === "number"
      ? { trialEnd: parseIsoDateTime(new Date(root.trial_end * 1000).toISOString()) }
      : {}),
    rawStatus,
  };
}

function commonPeriod(entries: readonly unknown[], field: string): unknown {
  const values = entries.map(
    (entry) => object(entry, "stripe", "stripe.subscription.decode")[field],
  );
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
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
  if (
    policy.timing !== "immediately" ||
    policy.invoiceBehavior === "stop_billing" ||
    policy.invoiceBehavior === "free"
  )
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
  if (value === "unpaid") return "unpaid";
  if (value === "canceled" || value === "incomplete_expired") return "canceled";
  if (value === "incomplete") return "incomplete";
  return "unknown";
}

function collectionPause(value: unknown): Pick<ProviderSubscriptionSnapshot, "collectionPause"> {
  if (value === null || value === undefined) return {};
  const root = object(value, "stripe", "stripe.subscription.decode");
  const behavior = optionalString(root, "behavior");
  const invoiceBehavior = behavior === "keep_as_draft" ? "keep_draft" : behavior;
  if (
    invoiceBehavior !== "void" &&
    invoiceBehavior !== "keep_draft" &&
    invoiceBehavior !== "mark_uncollectible"
  )
    throw new TypeError("Unknown Stripe collection pause behavior");
  return {
    collectionPause: {
      invoiceBehavior,
      ...(typeof root.resumes_at === "number"
        ? { resumesAt: parseIsoDateTime(new Date(root.resumes_at * 1000).toISOString()) }
        : {}),
    },
  };
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
