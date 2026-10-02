import {
  object,
  assertSubscriptionIdentity,
  optionalString,
  stringField,
  positiveSubscriptionQuantity,
  singleSubscriptionItem,
  subscriptionUnsupported,
  type ProviderSubscriptionSnapshot,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import {
  assertFutureSubscriptionDate,
  assertSubscriptionItemChangePolicy,
  assertSubscriptionPausePolicy,
  parseIsoDateTime,
  type SubscriptionStatus,
} from "@polybill/core";
import { polarRequest, type PolarRequest } from "./client.js";
import { polarResult } from "./result.js";

export function createPolarSubscriptions(
  request: PolarRequest = polarRequest,
): SubscriptionProvider {
  const update = async (context: Parameters<PolarRequest>[0], id: string, body: unknown) =>
    polarResult(context, decode((await request(context, "PATCH", path(id), body)).json()));
  return {
    async get(context, id) {
      return polarResult(context, decode((await request(context, "GET", path(id))).json()));
    },
    async cancel(context, id, timing) {
      if (timing !== "immediately" && timing !== "period_end")
        throw new TypeError("Invalid cancellation timing");
      return timing === "immediately"
        ? polarResult(context, decode((await request(context, "DELETE", path(id))).json()))
        : update(context, id, { cancel_at_period_end: true });
    },
    async pause(context, id, policy) {
      assertSubscriptionPausePolicy(policy, context.clock.now());
      if (policy.timing !== "period_end" || policy.invoiceBehavior !== "stop_billing")
        throw subscriptionUnsupported("polar", "Polar pauses billing only at period end");
      return update(context, id, {
        pause_at_period_end: true,
        ...(policy.resumesAt === undefined ? {} : { resumes_at: policy.resumesAt }),
      });
    },
    async resume(context, id) {
      return update(context, id, { resume: true });
    },
    async clearScheduledChange(context, id, kind) {
      if (!["cancel", "pause", "items"].includes(kind))
        throw new TypeError("Invalid scheduled change");
      return update(
        context,
        id,
        kind === "cancel"
          ? { cancel_at_period_end: false }
          : kind === "pause"
            ? { pause_at_period_end: false }
            : { pending_update: null },
      );
    },
    async setTrialEnd(context, id, end) {
      if (end !== "now") assertFutureSubscriptionDate(end, context.clock.now());
      return update(context, id, { trial_end: end });
    },
    async changeItems(context, id, input) {
      const item = singleSubscriptionItem(input.items, "polar");
      assertSubscriptionItemChangePolicy(input.policy);
      if (
        (input.policy.timing === "period_end" && input.policy.proration !== "none") ||
        (input.policy.timing === "immediately" && input.policy.proration === "none")
      )
        throw subscriptionUnsupported(
          "polar",
          "Polar supports next-period changes without proration, or immediate changes with explicit proration",
        );
      const current = object(
        (await request(context, "GET", path(id))).json(),
        "polar",
        "polar.subscription.read",
      );
      const snapshot = decode(current);
      assertSubscriptionIdentity(snapshot.externalId, id, "polar");
      const currentItem = snapshot.items[0];
      if (currentItem === undefined) throw new TypeError("Missing subscription item");
      const proration_behavior =
        input.policy.timing === "period_end"
          ? "next_period"
          : input.policy.proration === "prorate_immediately"
            ? "invoice"
            : "prorate";
      if (item.externalPriceId !== currentItem.externalPriceId) {
        if (item.quantity !== currentItem.quantity)
          throw subscriptionUnsupported(
            "polar",
            "Change product and quantity in separate operations; Polar uses distinct update schemas",
          );
        return update(context, id, { product_id: item.externalPriceId, proration_behavior });
      }
      const quantityKey =
        current.seats !== null && current.seats !== undefined
          ? "seats"
          : current.units !== null && current.units !== undefined
            ? "units"
            : undefined;
      if (quantityKey === undefined) {
        if (item.quantity !== 1)
          throw subscriptionUnsupported(
            "polar",
            "Quantity changes require a seat-based or unit-based subscription",
          );
        return polarResult(context, snapshot);
      }
      return update(context, id, { [quantityKey]: item.quantity, proration_behavior });
    },
  };
}

function path(id: string): string {
  return `/v1/subscriptions/${encodeURIComponent(id)}`;
}

export function decodePolarSubscription(value: unknown): ProviderSubscriptionSnapshot {
  return decode(value);
}

function decode(value: unknown): ProviderSubscriptionSnapshot {
  const root = object(value, "polar", "polar.subscription.decode");
  const rawStatus = stringField(root, "status", "polar", "polar.subscription.decode");
  const product = stringField(root, "product_id", "polar", "polar.subscription.decode");
  const quantity = positiveSubscriptionQuantity(root.seats ?? root.units ?? 1, "polar");
  const start = optionalString(root, "current_period_start");
  const end = optionalString(root, "current_period_end");
  const trial = optionalString(root, "trial_end");
  const resumes = optionalString(root, "resumes_at");
  const pending =
    root.pending_update == null
      ? undefined
      : object(root.pending_update, "polar", "polar.subscription.decode");
  const scheduled: ProviderSubscriptionSnapshot["scheduledChange"] =
    pending !== undefined
      ? {
          kind: "items",
          effectiveAt: parseIsoDateTime(
            stringField(pending, "applies_at", "polar", "polar.subscription.decode"),
          ),
          items: [
            {
              externalPriceId: optionalString(pending, "product_id") ?? product,
              quantity: positiveSubscriptionQuantity(
                pending.seats ?? pending.units ?? quantity,
                "polar",
              ),
            },
          ],
        }
      : end !== undefined &&
          (root.pause_at_period_end === true || root.cancel_at_period_end === true)
        ? {
            kind: root.cancel_at_period_end === true ? "cancel" : "pause",
            effectiveAt: parseIsoDateTime(end),
          }
        : rawStatus === "paused" && resumes !== undefined
          ? { kind: "resume", effectiveAt: parseIsoDateTime(resumes) }
          : undefined;
  return {
    externalId: stringField(root, "id", "polar", "polar.subscription.decode"),
    externalCustomerId: stringField(root, "customer_id", "polar", "polar.subscription.decode"),
    status: status(rawStatus),
    items: [{ externalPriceId: product, quantity }],
    ...(start === undefined ? {} : { currentPeriodStart: parseIsoDateTime(start) }),
    ...(end === undefined ? {} : { currentPeriodEnd: parseIsoDateTime(end) }),
    ...(trial === undefined ? {} : { trialEnd: parseIsoDateTime(trial) }),
    ...(resumes === undefined ? {} : { resumesAt: parseIsoDateTime(resumes) }),
    ...(scheduled === undefined ? {} : { scheduledChange: scheduled }),
    cancelAtPeriodEnd: root.cancel_at_period_end === true,
    rawStatus,
  };
}
function status(value: string): SubscriptionStatus | "unknown" {
  switch (value) {
    case "incomplete":
    case "trialing":
    case "active":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "paused":
      return value;
    case "revoked":
      return "canceled";
    default:
      return "unknown";
  }
}
