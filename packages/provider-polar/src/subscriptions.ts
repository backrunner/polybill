import {
  object,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import { parseIsoDateTime, type SubscriptionStatus } from "@polybill/core";
import { polarRequest } from "./client.js";
import { polarResult } from "./result.js";

export const polarSubscriptions: SubscriptionProvider = {
  async get(context, externalId) {
    return polarResult(
      context,
      decode(
        (
          await polarRequest(context, "GET", `/v1/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async cancel(context, externalId, timing) {
    const response =
      timing === "immediately"
        ? await polarRequest(
            context,
            "DELETE",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
          )
        : await polarRequest(
            context,
            "PATCH",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
            {
              cancel_at_period_end: true,
            },
          );
    return polarResult(context, decode(response.json()));
  },
  async resume(context, externalId) {
    return polarResult(
      context,
      decode(
        (
          await polarRequest(
            context,
            "PATCH",
            `/v1/subscriptions/${encodeURIComponent(externalId)}`,
            {
              resume: true,
            },
          )
        ).json(),
      ),
    );
  },
};

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "polar", "polar.subscription.decode");
  const rawStatus = stringField(root, "status", "polar", "polar.subscription.decode");
  const seats = root.seats;
  const start = optionalString(root, "current_period_start");
  const end = optionalString(root, "current_period_end");
  return {
    externalId: stringField(root, "id", "polar", "polar.subscription.decode"),
    externalCustomerId: stringField(root, "customer_id", "polar", "polar.subscription.decode"),
    status: status(rawStatus),
    items: [
      {
        externalPriceId: stringField(root, "product_id", "polar", "polar.subscription.decode"),
        quantity: Number.isSafeInteger(seats) && Number(seats) > 0 ? Number(seats) : 1,
      },
    ],
    ...(start === undefined ? {} : { currentPeriodStart: parseIsoDateTime(start) }),
    ...(end === undefined ? {} : { currentPeriodEnd: parseIsoDateTime(end) }),
    cancelAtPeriodEnd: root.cancel_at_period_end === true,
    rawStatus,
  };
}

function status(value: string): SubscriptionStatus | "unknown" {
  if (["incomplete", "trialing", "active", "past_due", "unpaid", "canceled"].includes(value))
    return value as SubscriptionStatus;
  if (value === "revoked") return "canceled";
  if (value === "paused") return "paused";
  return "unknown";
}
