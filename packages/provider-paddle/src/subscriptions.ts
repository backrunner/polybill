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
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
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
  async changeItems(context, externalId, input) {
    assertItemChange(context.connection.id, input.policy);
    return update(context, externalId, {
      items: input.items.map((item) => ({
        price_id: item.externalPriceId,
        quantity: item.quantity,
      })),
      proration_billing_mode: proration(input.policy.proration),
    });
  },
  async pause(context, externalId, policy) {
    assertPause(context.connection.id, policy);
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(
            context,
            "POST",
            `/subscriptions/${encodeURIComponent(externalId)}/pause`,
            {
              effective_from:
                policy.timing === "immediately" ? "immediately" : "next_billing_period",
            },
          )
        ).json(),
      ),
    );
  },
  async resume(context, externalId) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(
            context,
            "POST",
            `/subscriptions/${encodeURIComponent(externalId)}/resume`,
            { effective_from: "immediately", on_resume: "start_new_billing_period" },
          )
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
            "POST",
            `/subscriptions/${encodeURIComponent(externalId)}/cancel`,
            {
              effective_from: timing === "immediately" ? "immediately" : "next_billing_period",
            },
          )
        ).json(),
      ),
    );
  },
};

async function update(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  body: unknown,
) {
  return paddleResult(
    context,
    decode(
      (
        await paddleRequest(
          context,
          "PATCH",
          `/subscriptions/${encodeURIComponent(externalId)}`,
          body,
        )
      ).json(),
    ),
  );
}

function assertItemChange(connectionId: ConnectionId, policy: SubscriptionItemChangePolicy): void {
  if (policy.timing !== "immediately")
    throw unsupported(connectionId, "Paddle item changes take effect immediately");
}

function assertPause(connectionId: ConnectionId, policy: SubscriptionPausePolicy): void {
  if (policy.invoiceBehavior !== "stop_billing")
    throw unsupported(
      connectionId,
      "Paddle pause stops billing and cannot map this invoice policy",
    );
}

function proration(value: SubscriptionItemChangePolicy["proration"]): string {
  if (value === "none") return "do_not_bill";
  if (value === "prorate_next_invoice") return "prorated_next_billing_period";
  return "prorated_immediately";
}

function unsupported(connectionId: ConnectionId, message: string): PolybillError {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "paddle.subscription.update",
    provider: "paddle",
    connectionId,
    retryable: false,
  });
}

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
