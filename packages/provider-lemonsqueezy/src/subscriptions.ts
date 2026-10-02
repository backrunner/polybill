import {
  object,
  assertSubscriptionIdentity,
  positiveSubscriptionQuantity,
  singleSubscriptionItem,
  subscriptionUnsupported,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  assertFutureSubscriptionDate,
  assertSubscriptionItemChangePolicy,
  assertSubscriptionPausePolicy,
  parseIsoDateTime,
  type ConnectionId,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { lemonRequest } from "./client.js";
import { lemonResult } from "./result.js";

export const lemonSubscriptions: SubscriptionProvider = {
  async changeItems(context, externalId, input) {
    const item = singleSubscriptionItem(input.items, "lemonSqueezy");
    assertSubscriptionItemChangePolicy(input.policy);
    if (input.policy.timing !== "immediately")
      throw subscriptionUnsupported(
        "lemonSqueezy",
        "Lemon Squeezy item changes take effect immediately",
      );
    if (
      !/^[1-9][0-9]*$/.test(item.externalPriceId) ||
      !Number.isSafeInteger(Number(item.externalPriceId))
    )
      throw new TypeError("Invalid Lemon Squeezy variant ID");
    const raw = (await lemonRequest(context, "GET", path(externalId))).json();
    const current = attributes(raw);
    assertServerMutation(current);
    const snapshot = decode(raw);
    assertSubscriptionIdentity(snapshot.externalId, externalId, "lemonSqueezy");
    const flags = {
      invoice_immediately: input.policy.proration === "prorate_immediately",
      disable_prorations: input.policy.proration === "none",
    };
    if (item.externalPriceId !== String(current.variant_id)) {
      if (item.quantity !== snapshot.items[0]?.quantity)
        throw subscriptionUnsupported(
          "lemonSqueezy",
          "Change variant and quantity separately to avoid duplicate prorations",
        );
      return update(context, externalId, { variant_id: Number(item.externalPriceId), ...flags });
    }
    const first = object(
      current.first_subscription_item,
      "lemonSqueezy",
      "lemonSqueezy.subscription.read",
    );
    if (first.is_usage_based === true)
      throw subscriptionUnsupported(
        "lemonSqueezy",
        "Metered items require usage records, not a quantity update",
      );
    const itemId = externalIdValue(first.id);
    if (first.subscription_id !== undefined)
      assertSubscriptionIdentity(
        externalIdValue(first.subscription_id),
        externalId,
        "lemonSqueezy",
      );
    await lemonRequest(context, "PATCH", `/subscription-items/${encodeURIComponent(itemId)}`, {
      data: {
        type: "subscription-items",
        id: itemId,
        attributes: { quantity: item.quantity, ...flags },
      },
    });
    return lemonResult(
      context,
      decode((await lemonRequest(context, "GET", path(externalId))).json()),
    );
  },
  async clearScheduledChange(context, externalId, kind) {
    if (kind !== "cancel")
      throw subscriptionUnsupported(
        "lemonSqueezy",
        "Only a scheduled cancellation can be reversed",
      );
    return update(context, externalId, { cancelled: false });
  },
  async setTrialEnd(context, externalId, end) {
    if (end !== "now") assertFutureSubscriptionDate(end, context.clock.now());
    return update(context, externalId, {
      trial_ends_at: end === "now" ? context.clock.now() : end,
    });
  },
  async get(context, externalId) {
    return lemonResult(
      context,
      decode((await lemonRequest(context, "GET", path(externalId))).json()),
    );
  },
  async pause(context, externalId, policy) {
    assertSubscriptionPausePolicy(policy, context.clock.now());
    assertPausePolicy(context.connection.id, policy);
    return update(context, externalId, {
      pause: {
        mode: policy.invoiceBehavior,
        ...(policy.resumesAt === undefined ? {} : { resumes_at: policy.resumesAt }),
      },
    });
  },
  async resume(context, externalId) {
    return update(context, externalId, { pause: null });
  },
  async cancel(context, externalId, timing) {
    if (timing === "immediately")
      throw new PolybillError("Lemon Squeezy cancellation preserves access until period end", {
        code: "unsupported_capability",
        operation: "lemonSqueezy.subscription.cancel",
        provider: "lemonSqueezy",
        connectionId: context.connection.id,
        retryable: false,
      });
    return lemonResult(
      context,
      decode((await lemonRequest(context, "DELETE", path(externalId))).json()),
    );
  },
};

function assertPausePolicy(connectionId: ConnectionId, policy: SubscriptionPausePolicy): void {
  if (
    policy.timing !== "immediately" ||
    (policy.invoiceBehavior !== "void" && policy.invoiceBehavior !== "free")
  )
    throw new PolybillError("Lemon Squeezy supports immediate void or free collection pauses", {
      code: "unsupported_capability",
      operation: "lemonSqueezy.subscription.pause",
      provider: "lemonSqueezy",
      connectionId,
      retryable: false,
    });
}

async function update(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  changes: Readonly<Record<string, unknown>>,
) {
  const current = (await lemonRequest(context, "GET", path(externalId))).json();
  assertSubscriptionIdentity(decode(current).externalId, externalId, "lemonSqueezy");
  assertServerMutation(attributes(current));
  const response = (
    await lemonRequest(context, "PATCH", path(externalId), {
      data: { type: "subscriptions", id: externalId, attributes: changes },
    })
  ).json();
  if (attributes(response).payment_processor === "paypal")
    throw new PolybillError("Lemon Squeezy did not confirm the subscription mutation", {
      code: "outcome_unknown",
      operation: "lemonSqueezy.subscription.update",
      provider: "lemonSqueezy",
      retryable: false,
    });
  return lemonResult(context, decode(response));
}

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const data = object(
    object(value, "lemonSqueezy", "lemonSqueezy.subscription.decode").data,
    "lemonSqueezy",
    "lemonSqueezy.subscription.decode",
  );
  const root = object(data.attributes, "lemonSqueezy", "lemonSqueezy.subscription.decode");
  const rawStatus = stringField(root, "status", "lemonSqueezy", "lemonSqueezy.subscription.decode");
  const renewsAt = optionalString(root, "renews_at");
  const endsAt = optionalString(root, "ends_at");
  const first =
    root.first_subscription_item == null
      ? undefined
      : object(root.first_subscription_item, "lemonSqueezy", "lemonSqueezy.subscription.decode");
  const quantity = positiveSubscriptionQuantity(
    first?.quantity ?? root.variant_quantity ?? 1,
    "lemonSqueezy",
  );
  const trial = optionalString(root, "trial_ends_at");
  const pause =
    root.pause == null
      ? undefined
      : object(root.pause, "lemonSqueezy", "lemonSqueezy.subscription.decode");
  const pauseMode = pause?.mode;
  if (pause !== undefined && pauseMode !== "void" && pauseMode !== "free")
    throw new TypeError("Unknown Lemon Squeezy pause mode");
  const resumes = pause === undefined ? undefined : optionalString(pause, "resumes_at");
  return {
    externalId: stringField(data, "id", "lemonSqueezy", "lemonSqueezy.subscription.decode"),
    externalCustomerId: externalIdValue(root.customer_id),
    status: status(rawStatus, endsAt),
    items: [
      {
        externalPriceId: externalIdValue(root.variant_id),
        quantity,
      },
    ],
    ...(renewsAt === undefined ? {} : { currentPeriodEnd: parseIsoDateTime(renewsAt) }),
    ...(renewsAt === undefined && endsAt !== undefined
      ? { currentPeriodEnd: parseIsoDateTime(endsAt) }
      : {}),
    cancelAtPeriodEnd: rawStatus === "cancelled" && endsAt !== undefined,
    ...(rawStatus === "cancelled" && endsAt !== undefined
      ? { scheduledChange: { kind: "cancel" as const, effectiveAt: parseIsoDateTime(endsAt) } }
      : {}),
    ...(trial === undefined ? {} : { trialEnd: parseIsoDateTime(trial) }),
    ...(pauseMode !== "void" && pauseMode !== "free"
      ? {}
      : {
          collectionPause: {
            invoiceBehavior: pauseMode,
            ...(resumes === undefined ? {} : { resumesAt: parseIsoDateTime(resumes) }),
          },
        }),
    rawStatus,
  };
}

function attributes(value: unknown) {
  return object(
    object(
      object(value, "lemonSqueezy", "lemonSqueezy.subscription.read").data,
      "lemonSqueezy",
      "lemonSqueezy.subscription.read",
    ).attributes,
    "lemonSqueezy",
    "lemonSqueezy.subscription.read",
  );
}
function assertServerMutation(value: Readonly<Record<string, unknown>>): void {
  if (value.payment_processor === "paypal")
    throw subscriptionUnsupported(
      "lemonSqueezy",
      "PayPal subscriptions require customer portal authorization",
    );
}
function externalIdValue(value: unknown): string {
  if (
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && value.length > 0)
  )
    return String(value);
  throw new TypeError("Invalid Lemon Squeezy resource ID");
}

function status(value: string, endsAt: string | undefined): SubscriptionStatus | "unknown" {
  if (value === "on_trial") return "trialing";
  if (value === "cancelled" && endsAt !== undefined) return "active";
  if (value === "cancelled" || value === "expired") return "canceled";
  if (["active", "paused", "past_due", "unpaid"].includes(value))
    return value as SubscriptionStatus;
  return "unknown";
}

function path(externalId: string) {
  return `/subscriptions/${encodeURIComponent(externalId)}`;
}
