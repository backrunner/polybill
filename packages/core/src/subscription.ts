import type { CustomerId, PriceId, SubscriptionId } from "./ids.js";
import type { IsoDateTime } from "./time.js";
import { parseIsoDateTime } from "./time.js";

export type SubscriptionStatus =
  "incomplete" | "trialing" | "active" | "past_due" | "paused" | "unpaid" | "canceled";

export interface SubscriptionItem {
  readonly priceId: PriceId;
  readonly quantity: number;
  readonly currentPeriodStart?: IsoDateTime;
  readonly currentPeriodEnd?: IsoDateTime;
}

export type SubscriptionMutationTiming = "immediately" | "period_end";

export interface SubscriptionItemChangePolicy {
  readonly timing: SubscriptionMutationTiming;
  readonly proration: "none" | "prorate_next_invoice" | "prorate_immediately";
}

export interface SubscriptionPausePolicy {
  readonly timing: SubscriptionMutationTiming;
  readonly invoiceBehavior: "stop_billing" | "void" | "keep_draft" | "mark_uncollectible" | "free";
  readonly resumesAt?: IsoDateTime;
}

export interface SubscriptionCollectionPause {
  readonly invoiceBehavior: Exclude<SubscriptionPausePolicy["invoiceBehavior"], "stop_billing">;
  readonly resumesAt?: IsoDateTime;
}

export type SubscriptionScheduledChangeKind = "cancel" | "pause" | "items";
export type SubscriptionTrialEnd = IsoDateTime | "now";

export interface SubscriptionResumePolicy {
  readonly billingPeriod: "continue_current" | "restart";
}

export interface ScheduledSubscriptionChange {
  readonly kind: "cancel" | "pause" | "resume" | "items";
  readonly effectiveAt: IsoDateTime;
  readonly items?: readonly SubscriptionItem[];
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
  readonly collectionPause?: SubscriptionCollectionPause;
  readonly trialEnd?: IsoDateTime;
  readonly resumesAt?: IsoDateTime;
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
  if (
    !["immediately", "period_end"].includes(policy.timing) ||
    !["none", "prorate_next_invoice", "prorate_immediately"].includes(policy.proration)
  )
    throw new TypeError("Invalid subscription item change policy");
  if (policy.timing === "period_end" && policy.proration === "prorate_immediately") {
    throw new RangeError("A period-end item change cannot be prorated immediately");
  }
}

export function assertSubscriptionPausePolicy(
  policy: SubscriptionPausePolicy,
  now: IsoDateTime,
): void {
  if (
    !["immediately", "period_end"].includes(policy.timing) ||
    !["stop_billing", "void", "keep_draft", "mark_uncollectible", "free"].includes(
      policy.invoiceBehavior,
    )
  )
    throw new TypeError("Invalid subscription pause policy");
  if (policy.resumesAt !== undefined) assertFutureSubscriptionDate(policy.resumesAt, now);
}

export function assertFutureSubscriptionDate(value: IsoDateTime, now: IsoDateTime): void {
  parseIsoDateTime(value);
  if (Date.parse(value) <= Date.parse(now))
    throw new RangeError("Subscription date must be in the future");
}
