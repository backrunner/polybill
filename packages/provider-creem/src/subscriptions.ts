import {
  arrayField,
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
import { creemRequest } from "./client.js";
import { creemResult } from "./result.js";

export const creemSubscriptions: SubscriptionProvider = {
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
  if (policy.timing !== "immediately" || policy.invoiceBehavior !== "stop_billing")
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
          const priceId = optionalString(item, "price_id") ?? optionalString(item, "product_id");
          if (priceId === undefined) throw new TypeError("Creem subscription item has no price ID");
          const units = item.units;
          return {
            externalPriceId: priceId,
            quantity: Number.isSafeInteger(units) && Number(units) > 0 ? Number(units) : 1,
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
