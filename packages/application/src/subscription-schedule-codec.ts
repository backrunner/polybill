import { parseId, parseIsoDateTime, type Subscription } from "@polybill/core";
import type { BillingRecord } from "./billing-store.js";
import type { SubscriptionPhase, SubscriptionSchedule } from "./subscription-schedules.js";

export const scheduleWarning =
  "Execution depends on the host scheduler; provider invoice timing and billing-anchor preservation are not guaranteed.";

export function decodeSchedule(record: BillingRecord): SubscriptionSchedule {
  const value = object(record.value);
  const phases = decodePhases(value.phases);
  const phase = value.phase;
  const state = choice(value.state, [
    "preparing",
    "pending",
    "attempted",
    "complete",
    "needs_review",
    "canceled",
  ] as const);
  if (
    record.kind !== "schedule" ||
    value.id !== record.id ||
    !/^sched_[a-f0-9]{64}$/.test(record.id) ||
    typeof phase !== "number" ||
    !Number.isSafeInteger(phase) ||
    phase < 0 ||
    phase > phases.length ||
    (state === "complete") !== (phase === phases.length) ||
    (state === "preparing" && phase !== 0) ||
    typeof value.payloadHash !== "string" ||
    value.payloadHash.length === 0 ||
    value.strategy !== "host_scheduled_item_changes" ||
    value.warning !== scheduleWarning
  )
    throw new TypeError("Invalid stored schedule");
  const reviewReason =
    value.reviewReason === undefined
      ? undefined
      : choice(value.reviewReason, [
          "late_or_changed",
          "unconfirmed_attempt",
          "ownership_conflict",
        ] as const);
  if (state === "needs_review" && reviewReason === undefined)
    throw new TypeError("Missing schedule review reason");
  return {
    id: record.id,
    subscriptionId: parseId<"SubscriptionId">(value.subscriptionId, "sub"),
    phases,
    phase,
    expectedItems: items(value.expectedItems),
    state,
    ...(reviewReason === undefined ? {} : { reviewReason }),
    payloadHash: value.payloadHash,
    strategy: "host_scheduled_item_changes",
    warning: scheduleWarning,
  };
}

export function decodePhases(value: unknown): readonly SubscriptionPhase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new TypeError("Schedules need one to ten phases");
  let previous = -Infinity;
  return value.map((entry: unknown) => {
    const phase = object(entry);
    const executeAt = parseIsoDateTime(phase.executeAt);
    const latestAt = parseIsoDateTime(phase.latestAt);
    if (Date.parse(executeAt) <= previous || Date.parse(latestAt) < Date.parse(executeAt))
      throw new TypeError("Invalid phase windows");
    previous = Date.parse(latestAt);
    return {
      executeAt,
      latestAt,
      items: items(phase.items),
      proration: choice(phase.proration, [
        "none",
        "prorate_next_invoice",
        "prorate_immediately",
      ] as const),
    };
  });
}

function items(value: unknown): Subscription["items"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw new TypeError("Invalid schedule items");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    const item = object(entry);
    const priceId = parseId<"PriceId">(item.priceId, "price");
    if (
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      seen.has(priceId)
    )
      throw new TypeError("Invalid schedule item quantity or duplicate price");
    seen.add(priceId);
    return { priceId, quantity: item.quantity };
  });
}
function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid schedule data");
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find((option) => option === value);
  if (result === undefined) throw new TypeError("Invalid schedule field");
  return result;
}
