import {
  arrayField,
  object,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import { parseIsoDateTime, type SubscriptionStatus } from "@polybill/core";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleSubscriptions: SubscriptionProvider = {
  async get(context, externalId) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async cancel(context, externalId, timing) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(
            context,
            "PATCH",
            `/subscriptions/${encodeURIComponent(externalId)}`,
            {
              scheduled_change: {
                action: "cancel",
                effective_at: timing === "immediately" ? "immediately" : "next_billing_period",
              },
            },
          )
        ).json(),
      ),
    );
  },
};

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const data = object(
    object(value, "paddle", "paddle.subscription.decode").data,
    "paddle",
    "paddle.subscription.decode",
  );
  const rawStatus = stringField(data, "status", "paddle", "paddle.subscription.decode");
  const period =
    data.current_billing_period === null || data.current_billing_period === undefined
      ? undefined
      : object(data.current_billing_period, "paddle", "paddle.subscription.decode");
  const start = period === undefined ? undefined : optionalString(period, "starts_at");
  const end = period === undefined ? undefined : optionalString(period, "ends_at");
  const scheduled =
    data.scheduled_change === null || data.scheduled_change === undefined
      ? undefined
      : object(data.scheduled_change, "paddle", "paddle.subscription.decode");
  return {
    externalId: stringField(data, "id", "paddle", "paddle.subscription.decode"),
    externalCustomerId: stringField(data, "customer_id", "paddle", "paddle.subscription.decode"),
    status: status(rawStatus),
    items: arrayField(data, "items", "paddle", "paddle.subscription.decode").map((entry) => {
      const item = object(entry, "paddle", "paddle.subscription.decode");
      const price = object(item.price, "paddle", "paddle.subscription.decode");
      const quantity = item.quantity;
      if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
        throw new TypeError("Paddle subscription quantity is invalid");
      return {
        externalPriceId: stringField(price, "id", "paddle", "paddle.subscription.decode"),
        quantity: Number(quantity),
      };
    }),
    ...(start === undefined ? {} : { currentPeriodStart: parseIsoDateTime(start) }),
    ...(end === undefined ? {} : { currentPeriodEnd: parseIsoDateTime(end) }),
    cancelAtPeriodEnd:
      scheduled !== undefined &&
      scheduled.action === "cancel" &&
      scheduled.effective_at !== "immediately",
    rawStatus,
  };
}

function status(value: string): SubscriptionStatus | "unknown" {
  if (["active", "trialing", "past_due", "paused", "canceled"].includes(value))
    return value as SubscriptionStatus;
  return "unknown";
}
