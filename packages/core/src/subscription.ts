import type { CustomerId, PriceId, SubscriptionId } from "./ids.js";
import type { IsoDateTime } from "./time.js";

export type SubscriptionStatus =
  "incomplete" | "trialing" | "active" | "past_due" | "paused" | "unpaid" | "canceled";

export interface SubscriptionItem {
  readonly priceId: PriceId;
  readonly quantity: number;
}

export type SubscriptionMutationTiming = "immediately" | "period_end";

export interface SubscriptionItemChangePolicy {
  readonly timing: SubscriptionMutationTiming;
  readonly proration: "none" | "prorate_next_invoice" | "prorate_immediately";
}

export interface SubscriptionPausePolicy {
  readonly timing: SubscriptionMutationTiming;
  readonly invoiceBehavior: "stop_billing" | "void" | "keep_draft" | "mark_uncollectible";
}

export interface ScheduledSubscriptionChange {
  readonly kind: "cancel" | "pause" | "resume" | "items";
  readonly effectiveAt: IsoDateTime;
}

export interface Subscription {
  readonly id: SubscriptionId;
  readonly customerId: CustomerId;
  readonly status: SubscriptionStatus;
  readonly items: readonly SubscriptionItem[];
  readonly currentPeriodStart?: IsoDateTime;
  readonly currentPeriodEnd?: IsoDateTime;
  readonly accessUntil?: IsoDateTime;
  readonly scheduledChange?: ScheduledSubscriptionChange;
  readonly version: number;
  readonly rawStatus?: string;
}

export function scheduleSubscriptionChange(
  subscription: Subscription,
  change: ScheduledSubscriptionChange,
): Subscription {
  if (subscription.status === "canceled") {
    throw new RangeError("A canceled subscription cannot receive scheduled changes");
  }
  return { ...subscription, scheduledChange: change, version: subscription.version + 1 };
}

export function applyObservedSubscriptionStatus(
  subscription: Subscription,
  status: SubscriptionStatus,
  rawStatus?: string,
): Subscription {
  if (subscription.status === "canceled" && status !== "canceled") {
    throw new RangeError("A canceled subscription cannot return to a billable status");
  }
  return {
    ...subscription,
    status,
    ...(rawStatus === undefined ? {} : { rawStatus }),
    version: subscription.version + 1,
  };
}

export function assertSubscriptionItemChangePolicy(policy: SubscriptionItemChangePolicy): void {
  if (policy.timing === "period_end" && policy.proration === "prorate_immediately") {
    throw new RangeError("A period-end item change cannot be prorated immediately");
  }
}
