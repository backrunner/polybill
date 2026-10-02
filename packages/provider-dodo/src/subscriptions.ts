import {
  object,
  assertSubscriptionIdentity,
  optionalString,
  singleSubscriptionItem,
  positiveSubscriptionQuantity,
  subscriptionUnsupported,
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
import { dodoRequest } from "./client.js";
import { dodoResult } from "./result.js";

export const dodoSubscriptions: SubscriptionProvider = {
  async changeItems(context, externalId, input) {
    const item = singleSubscriptionItem(input.items, "dodo");
    assertSubscriptionItemChangePolicy(input.policy);
    if (
      input.policy.proration === "prorate_next_invoice" ||
      (input.policy.timing === "period_end" && input.policy.proration !== "none")
    )
      throw subscriptionUnsupported(
        "dodo",
        "Dodo supports immediate proration or an unprorated next-billing-date change",
      );
    const current = object(
      (
        await dodoRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
      ).json(),
      "dodo",
      "dodo.subscription.read",
    );
    assertSubscriptionIdentity(current.subscription_id, externalId, "dodo");
    await dodoRequest(
      context,
      "POST",
      `/subscriptions/${encodeURIComponent(externalId)}/change-plan`,
      {
        product_id: item.externalPriceId,
        quantity: item.quantity,
        proration_billing_mode:
          input.policy.proration === "none" ? "do_not_bill" : "prorated_immediately",
        effective_at: input.policy.timing === "period_end" ? "next_billing_date" : "immediately",
        on_payment_failure: "prevent_change",
        addons: preservedAddons(current.addons),
      },
    );
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async clearScheduledChange(context, externalId, kind) {
    if (kind === "cancel") {
      return dodoResult(
        context,
        decode(
          (
            await dodoRequest(
              context,
              "PATCH",
              `/subscriptions/${encodeURIComponent(externalId)}`,
              { cancel_at_next_billing_date: false },
            )
          ).json(),
        ),
      );
    }
    if (kind !== "items")
      throw subscriptionUnsupported("dodo", "Dodo has no scheduled pause to clear");
    await dodoRequest(
      context,
      "DELETE",
      `/subscriptions/${encodeURIComponent(externalId)}/change-plan/scheduled`,
    );
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "GET", `/subscriptions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async cancel(context, externalId, timing) {
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(
            context,
            "PATCH",
            `/subscriptions/${encodeURIComponent(externalId)}`,
            timing === "immediately"
              ? { status: "cancelled", cancel_reason: "cancelled_by_merchant" }
              : { cancel_at_next_billing_date: true },
          )
        ).json(),
      ),
    );
  },
  async pause(context, externalId, policy) {
    assertSubscriptionPausePolicy(policy, context.clock.now());
    assertPausePolicy(context.connection.id, policy);
    return lifecycle(context, externalId, "paused");
  },
  async resume(context, externalId) {
    return lifecycle(context, externalId, "active");
  },
};

function preservedAddons(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError("Invalid Dodo add-ons");
  return value.map((entry) => {
    const addon = object(entry, "dodo", "dodo.subscription.read");
    return {
      addon_id: stringField(addon, "addon_id", "dodo", "dodo.subscription.read"),
      quantity: positiveSubscriptionQuantity(addon.quantity, "dodo"),
    };
  });
}

async function lifecycle(
  context: Parameters<NonNullable<SubscriptionProvider["get"]>>[0],
  externalId: string,
  status: "paused" | "active",
) {
  return dodoResult(
    context,
    decode(
      (
        await dodoRequest(context, "PATCH", `/subscriptions/${encodeURIComponent(externalId)}`, {
          status,
        })
      ).json(),
    ),
  );
}

function assertPausePolicy(connectionId: ConnectionId, policy: SubscriptionPausePolicy): void {
  if (
    policy.timing !== "immediately" ||
    policy.invoiceBehavior !== "stop_billing" ||
    policy.resumesAt !== undefined
  )
    throw new PolybillError("Dodo only supports an immediate stop-billing pause", {
      code: "unsupported_capability",
      operation: "dodo.subscription.pause",
      provider: "dodo",
      connectionId,
      retryable: false,
    });
}

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "dodo", "dodo.subscription.decode");
  const rawStatus = stringField(root, "status", "dodo", "dodo.subscription.decode");
  const customer = object(root.customer, "dodo", "dodo.subscription.decode");
  const quantity = root.quantity;
  if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
    throw new TypeError("Dodo subscription quantity is invalid");
  const pending =
    root.scheduled_change == null
      ? undefined
      : object(root.scheduled_change, "dodo", "dodo.subscription.decode");
  const trialEnd = optionalString(root, "trial_end");
  return {
    externalId: stringField(root, "subscription_id", "dodo", "dodo.subscription.decode"),
    externalCustomerId: stringField(customer, "customer_id", "dodo", "dodo.subscription.decode"),
    status: canonicalStatus(rawStatus),
    items: [
      {
        externalPriceId: stringField(root, "product_id", "dodo", "dodo.subscription.decode"),
        quantity: Number(quantity),
      },
    ],
    currentPeriodStart: parseIsoDateTime(
      stringField(root, "previous_billing_date", "dodo", "dodo.subscription.decode"),
    ),
    currentPeriodEnd: parseIsoDateTime(
      stringField(root, "next_billing_date", "dodo", "dodo.subscription.decode"),
    ),
    cancelAtPeriodEnd: root.cancel_at_next_billing_date === true,
    ...(trialEnd === undefined ? {} : { trialEnd: parseIsoDateTime(trialEnd) }),
    ...(pending === undefined
      ? {}
      : {
          scheduledChange: {
            kind: "items" as const,
            effectiveAt: parseIsoDateTime(
              stringField(pending, "effective_at", "dodo", "dodo.subscription.decode"),
            ),
            items: [
              {
                externalPriceId: stringField(
                  pending,
                  "product_id",
                  "dodo",
                  "dodo.subscription.decode",
                ),
                quantity: positiveSubscriptionQuantity(pending.quantity, "dodo"),
              },
            ],
          },
        }),
    rawStatus,
  };
}

function canonicalStatus(value: string): SubscriptionStatus | "unknown" {
  if (["active", "paused", "past_due", "unpaid", "trialing"].includes(value))
    return value as SubscriptionStatus;
  if (["cancelled", "canceled", "expired", "failed"].includes(value)) return "canceled";
  if (value === "on_hold") return "unpaid";
  if (value === "pending") return "incomplete";
  return "unknown";
}
