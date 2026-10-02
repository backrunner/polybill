import {
  assertProviderSubscriptionItems,
  type ProviderSubscriptionSnapshot,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  parseIsoDateTime,
  type ProviderName,
  type SubscriptionStatus,
} from "@polybill/core";

export function validateSubscriptionSnapshot(
  snapshot: ProviderSubscriptionSnapshot,
  provider: ProviderName,
  previous?: SubscriptionStatus,
): void {
  try {
    if (
      !["incomplete", "trialing", "active", "past_due", "paused", "unpaid", "canceled"].includes(
        snapshot.status,
      ) ||
      typeof snapshot.externalId !== "string" ||
      snapshot.externalId.length === 0 ||
      typeof snapshot.externalCustomerId !== "string" ||
      snapshot.externalCustomerId.length === 0 ||
      typeof snapshot.cancelAtPeriodEnd !== "boolean" ||
      typeof snapshot.rawStatus !== "string" ||
      (previous === "canceled" && snapshot.status !== "canceled")
    )
      throw new TypeError("Invalid subscription state");
    assertProviderSubscriptionItems(snapshot.items);
    for (const item of snapshot.items) {
      if (item.currentPeriodStart !== undefined) parseIsoDateTime(item.currentPeriodStart);
      if (item.currentPeriodEnd !== undefined) parseIsoDateTime(item.currentPeriodEnd);
      if (
        item.currentPeriodStart !== undefined &&
        item.currentPeriodEnd !== undefined &&
        Date.parse(item.currentPeriodStart) >= Date.parse(item.currentPeriodEnd)
      )
        throw new TypeError("Invalid item period");
    }
    for (const date of [
      snapshot.currentPeriodStart,
      snapshot.currentPeriodEnd,
      snapshot.trialEnd,
      snapshot.resumesAt,
    ])
      if (date !== undefined) parseIsoDateTime(date);
    if (
      snapshot.currentPeriodStart !== undefined &&
      snapshot.currentPeriodEnd !== undefined &&
      Date.parse(snapshot.currentPeriodStart) > Date.parse(snapshot.currentPeriodEnd)
    )
      throw new TypeError("Invalid subscription period");
    if (snapshot.scheduledChange !== undefined) {
      const scheduled = snapshot.scheduledChange;
      if (!["cancel", "pause", "resume", "items"].includes(scheduled.kind))
        throw new TypeError("Invalid schedule kind");
      parseIsoDateTime(scheduled.effectiveAt);
      if (scheduled.items !== undefined) assertProviderSubscriptionItems(scheduled.items);
    }
    if (snapshot.collectionPause !== undefined) {
      if (
        !["void", "keep_draft", "mark_uncollectible", "free"].includes(
          snapshot.collectionPause.invoiceBehavior,
        )
      )
        throw new TypeError("Invalid collection pause");
      if (snapshot.collectionPause.resumesAt !== undefined)
        parseIsoDateTime(snapshot.collectionPause.resumesAt);
    }
  } catch {
    throw new PolybillError("Provider subscription snapshot violates the canonical contract", {
      code: "provider_response_invalid",
      operation: "subscription.decode",
      provider,
      retryable: false,
    });
  }
}
