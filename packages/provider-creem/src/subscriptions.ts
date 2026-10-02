import {
  arrayField,
  assertSubscriptionIdentity,
  object,
  singleSubscriptionItem,
  subscriptionUnsupported,
  positiveSubscriptionQuantity,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  assertSubscriptionItemChangePolicy,
  assertSubscriptionPausePolicy,
  parseIsoDateTime,
  type ConnectionId,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { creemRequest } from "./client.js";
import { creemResult } from "./result.js";

export const creemSubscriptions: SubscriptionProvider = {
  async changeItems(context, externalId, input) {
    const item = singleSubscriptionItem(input.items, "creem");
    assertSubscriptionItemChangePolicy(input.policy);
    if (input.policy.timing !== "immediately")
      throw subscriptionUnsupported("creem", "Creem item changes apply immediately");
    const current = object(
      (
        await creemRequest(
          context,
          "GET",
          `/v1/subscriptions?${new URLSearchParams({ subscription_id: externalId })}`,
        )
      ).json(),
      "creem",
      "creem.subscription.read",
    );
    assertSubscriptionIdentity(current.id, externalId, "creem");
    const productId = id(current.product, "product");
    const entries =
      current.items === undefined
        ? []
        : arrayField(current, "items", "creem", "creem.subscription.read").map((entry) =>
            object(entry, "creem", "creem.subscription.read"),
          );
    if (entries.length > 1)
      throw subscriptionUnsupported(
        "creem",
        "Use explicit add-on management for multi-item Creem subscriptions",
      );
    const existing = entries.find(
      (entry) => (optionalString(entry, "product_id") ?? productId) === item.externalPriceId,
    );
    const update_behavior =
      input.policy.proration === "none"
        ? "proration-none"
        : input.policy.proration === "prorate_immediately"
          ? "proration-charge-immediately"
          : "proration-charge";
    if (existing !== undefined) {
      return creemResult(
        context,
        decode(
          (
            await creemRequest(
              context,
              "POST",
              `/v1/subscriptions/${encodeURIComponent(externalId)}`,
              {
                items: [
                  {
                    id: stringField(existing, "id", "creem", "creem.subscription.read"),
                    units: item.quantity,
                  },
                ],
                update_behavior,
              },
            )
          ).json(),
        ),
      );
    }
    if (item.quantity !== (decode(current).items[0]?.quantity ?? 1))
      throw subscriptionUnsupported(
        "creem",
        "Change product and quantity separately to avoid duplicate prorations",
      );
    if (productId === item.externalPriceId) return creemResult(context, decode(current));
    return creemResult(
      context,
      decode(
        (
          await creemRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}/upgrade`,
            {
              product_id: item.externalPriceId,
              update_behavior,
            },
          )
        ).json(),
      ),
    );
  },
  async clearScheduledChange(context, externalId, kind) {
    if (kind !== "cancel")
      throw subscriptionUnsupported("creem", "Creem can only reverse scheduled cancellation");
    const current = decode(
      (
        await creemRequest(
          context,
          "GET",
          `/v1/subscriptions?${new URLSearchParams({ subscription_id: externalId })}`,
        )
      ).json(),
    );
    assertSubscriptionIdentity(current.externalId, externalId, "creem");
    if (!current.cancelAtPeriodEnd) {
      if (current.status !== "active")
        throw subscriptionUnsupported(
          "creem",
          "Only a scheduled cancellation can be reversed; use resume for a paused subscription",
        );
      return creemResult(context, current);
    }
    return creemResult(
      context,
      decode(
        (
          await creemRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}/resume`,
          )
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    const query = new URLSearchParams({ subscription_id: externalId });
    return creemResult(
      context,
      decode((await creemRequest(context, "GET", `/v1/subscriptions?${query.toString()}`)).json()),
    );
  },
  async cancel(context, externalId, timing) {
    return creemResult(
      context,
      decode(
        (
          await creemRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}/cancel`,
            { mode: timing === "immediately" ? "immediate" : "scheduled" },
          )
        ).json(),
      ),
    );
  },
  async pause(context, externalId, policy) {
    assertSubscriptionPausePolicy(policy, context.clock.now());
    assertPausePolicy(context.connection.id, policy);
    return creemResult(
      context,
      decode(
        (
          await creemRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}/pause`,
          )
        ).json(),
      ),
    );
  },
  async resume(context, externalId) {
    return creemResult(
      context,
      decode(
        (
          await creemRequest(
            context,
            "POST",
            `/v1/subscriptions/${encodeURIComponent(externalId)}/resume`,
          )
        ).json(),
      ),
    );
  },
};

function assertPausePolicy(connectionId: ConnectionId, policy: SubscriptionPausePolicy): void {
  if (
    policy.timing !== "immediately" ||
    policy.invoiceBehavior !== "stop_billing" ||
    policy.resumesAt !== undefined
  )
    throw new PolybillError("Creem only supports an immediate stop-billing pause", {
      code: "unsupported_capability",
      operation: "creem.subscription.pause",
      provider: "creem",
      connectionId,
      retryable: false,
    });
}

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "creem", "creem.subscription.decode");
  const rawStatus = stringField(root, "status", "creem", "creem.subscription.decode");
  const customer = id(root.customer, "customer");
  const items =
    root.items === undefined
      ? [{ externalPriceId: id(root.product, "product"), quantity: 1 }]
      : arrayField(root, "items", "creem", "creem.subscription.decode").map((entry) => {
          const item = object(entry, "creem", "creem.subscription.decode");
          const priceId =
            optionalString(item, "product_id") ??
            (Array.isArray(root.items) && root.items.length === 1
              ? id(root.product, "product")
              : undefined);
          if (priceId === undefined) throw new TypeError("Creem subscription item has no price ID");
          const units = item.units;
          return {
            externalPriceId: priceId,
            quantity: positiveSubscriptionQuantity(units ?? 1, "creem"),
          };
        });
  return {
    externalId: stringField(root, "id", "creem", "creem.subscription.decode"),
    externalCustomerId: customer,
    status: status(rawStatus),
    items,
    ...date(root, "current_period_start_date", "currentPeriodStart"),
    ...date(root, "current_period_end_date", "currentPeriodEnd"),
    cancelAtPeriodEnd: rawStatus === "scheduled_cancel",
    rawStatus,
  };
}

function id(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  return stringField(
    object(value, "creem", `creem.${name}.decode`),
    "id",
    "creem",
    `creem.${name}.decode`,
  );
}

function status(value: string): SubscriptionStatus | "unknown" {
  if (["active", "unpaid", "paused", "trialing", "past_due"].includes(value))
    return value as SubscriptionStatus;
  if (value === "canceled") return "canceled";
  if (value === "scheduled_cancel") return "active";
  return "unknown";
}

function date(
  root: Readonly<Record<string, unknown>>,
  source: string,
  target: "currentPeriodStart" | "currentPeriodEnd",
) {
  const value = optionalString(root, source);
  return value === undefined ? {} : { [target]: parseIsoDateTime(value) };
}
