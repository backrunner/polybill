import {
  object,
  optionalString,
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
import { lemonRequest } from "./client.js";
import { lemonResult } from "./result.js";

export const lemonSubscriptions: SubscriptionProvider = {
  async get(context, externalId) {
    return lemonResult(
      context,
      decode((await lemonRequest(context, "GET", path(externalId))).json()),
    );
  },
  async pause(context, externalId, policy) {
    assertPausePolicy(context.connection.id, policy);
    return update(context, externalId, { pause: { mode: "void" } });
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
  if (policy.timing !== "immediately" || policy.invoiceBehavior !== "void")
    throw new PolybillError("Lemon Squeezy only supports an immediate void-invoice pause", {
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
  attributes: Readonly<Record<string, unknown>>,
) {
  return lemonResult(
    context,
    decode(
      (
        await lemonRequest(context, "PATCH", path(externalId), {
          data: { type: "subscriptions", id: externalId, attributes },
        })
      ).json(),
    ),
  );
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
  const quantity = root.variant_quantity;
  return {
    externalId: stringField(data, "id", "lemonSqueezy", "lemonSqueezy.subscription.decode"),
    externalCustomerId: String(root.customer_id),
    status: status(rawStatus, endsAt),
    items: [
      {
        externalPriceId: String(root.variant_id),
        quantity: Number.isSafeInteger(quantity) && Number(quantity) > 0 ? Number(quantity) : 1,
      },
    ],
    ...(renewsAt === undefined ? {} : { currentPeriodEnd: parseIsoDateTime(renewsAt) }),
    ...(renewsAt === undefined && endsAt !== undefined
      ? { currentPeriodEnd: parseIsoDateTime(endsAt) }
      : {}),
    cancelAtPeriodEnd: rawStatus === "cancelled" && endsAt !== undefined,
    rawStatus,
  };
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
