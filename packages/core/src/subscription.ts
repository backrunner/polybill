import type { CustomerId, PriceId, SubscriptionId } from "./ids.js";
import type { IsoDateTime } from "./time.js";

export type SubscriptionStatus =
  "incomplete" | "trialing" | "active" | "past_due" | "paused" | "unpaid" | "canceled";

export interface SubscriptionItem {
  readonly priceId: PriceId;
  readonly quantity: number;
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
