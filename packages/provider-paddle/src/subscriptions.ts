import {
  arrayField,
  assertSubscriptionIdentity,
  assertProviderSubscriptionItems,
  object,
  subscriptionUnsupported,
  optionalString,
  stringField,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  assertSubscriptionPausePolicy,
  assertSubscriptionItemChangePolicy,
  assertFutureSubscriptionDate,
  parseIsoDateTime,
  type ConnectionId,
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleSubscriptions: SubscriptionProvider = {
  async resumeWithPolicy(context, externalId, policy) {
    if (policy.billingPeriod !== "continue_current" && policy.billingPeriod !== "restart")
      throw new TypeError("Invalid resume billing-period policy");
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(
            context,
            "POST",
            `/subscriptions/${encodeURIComponent(externalId)}/resume`,
            {
              effective_from: "immediately",
              on_resume:
                policy.billingPeriod === "continue_current"
                  ? "continue_existing_billing_period"
                  : "start_new_billing_period",
            },
          )
        ).json(),
      ),
    );
  },
  async setTrialEnd(context, externalId, end) {
    if (end !== "now") {
      assertFutureSubscriptionDate(end, context.clock.now());
      if (Date.parse(end) - Date.parse(context.clock.now()) < 30 * 60 * 1000)
        throw subscriptionUnsupported(
          "paddle",
          "Paddle trial end must be at least 30 minutes in the future",
        );
    }
    const current = object(
      object(
        (
          await paddleRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
        "paddle",
        "paddle.subscription.read",
      ).data,
      "paddle",
      "paddle.subscription.read",
    );
    assertSubscriptionIdentity(current.id, externalId, "paddle");
    if (current.status !== "trialing")
      throw subscriptionUnsupported(
        "paddle",
        "Only a trialing subscription can change its trial end",
      );
    if (end === "now") {
      if (current.collection_mode !== "automatic")
        throw subscriptionUnsupported(
          "paddle",
          "Immediate trial activation requires automatic collection",
        );
      return paddleResult(
        context,
        decode(
          (
            await paddleRequest(
              context,
              "POST",
              `/subscriptions/${encodeURIComponent(externalId)}/activate`,
              {},
            )
          ).json(),
        ),
      );
    }
    return update(context, externalId, {
      next_billed_at: end,
      proration_billing_mode: "do_not_bill",
    });
  },
  async clearScheduledChange(context, externalId, kind) {
    if (kind === "items")
      throw subscriptionUnsupported("paddle", "Paddle item updates are immediate");
    if (kind !== "cancel" && kind !== "pause") throw new TypeError("Invalid scheduled change");
    const current = object(
      object(
        (
          await paddleRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
        "paddle",
        "paddle.subscription.read",
      ).data,
      "paddle",
      "paddle.subscription.read",
    );
    assertSubscriptionIdentity(current.id, externalId, "paddle");
    const scheduled =
      current.scheduled_change == null
        ? undefined
        : object(current.scheduled_change, "paddle", "paddle.subscription.read");
    if (scheduled !== undefined && scheduled.action !== kind)
      throw subscriptionUnsupported(
        "paddle",
        "Pending Paddle change does not match the requested kind",
      );
    return update(context, externalId, { scheduled_change: null });
  },
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
    assertProviderSubscriptionItems(input.items);
    assertSubscriptionItemChangePolicy(input.policy);
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
    assertSubscriptionPausePolicy(policy, context.clock.now());
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
              ...(policy.resumesAt === undefined ? {} : { resume_at: policy.resumesAt }),
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
  const resumesAt =
    scheduled === undefined
      ? undefined
      : scheduled.action === "resume"
        ? optionalString(scheduled, "effective_at")
        : scheduled.action === "pause"
          ? optionalString(scheduled, "resume_at")
          : undefined;
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
    ...(scheduled === undefined ? {} : { scheduledChange: decodeScheduled(scheduled) }),
    ...(resumesAt === undefined ? {} : { resumesAt: parseIsoDateTime(resumesAt) }),
    ...(optionalString(data, "next_billed_at") === undefined || rawStatus !== "trialing"
      ? {}
      : {
          trialEnd: parseIsoDateTime(
            stringField(data, "next_billed_at", "paddle", "paddle.subscription.decode"),
          ),
        }),
    rawStatus,
  };
}

function decodeScheduled(
  value: Readonly<Record<string, unknown>>,
): NonNullable<ProviderSubscriptionSnapshot["scheduledChange"]> {
  const kind = value.action;
  if (kind !== "cancel" && kind !== "pause" && kind !== "resume")
    throw new TypeError("Unknown Paddle scheduled action");
  return {
    kind,
    effectiveAt: parseIsoDateTime(
      stringField(value, "effective_at", "paddle", "paddle.subscription.decode"),
    ),
  };
}

function status(value: string): SubscriptionStatus | "unknown" {
  if (["active", "trialing", "past_due", "paused", "canceled"].includes(value))
    return value as SubscriptionStatus;
  return "unknown";
}
