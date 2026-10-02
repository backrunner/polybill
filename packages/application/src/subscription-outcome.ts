import type { ProviderSubscriptionSnapshot } from "@polybill/adapter-kit";
import {
  PolybillError,
  type IsoDateTime,
  type ProviderName,
  type SubscriptionPausePolicy,
  type SubscriptionScheduledChangeKind,
  type SubscriptionStatus,
  type SubscriptionTrialEnd,
} from "@polybill/core";

type ExpectedOutcome =
  | {
      readonly action: "cancel";
      readonly timing: "immediately" | "period_end";
      readonly previous: SubscriptionStatus;
    }
  | { readonly action: "pause"; readonly policy: SubscriptionPausePolicy }
  | { readonly action: "resume" }
  | { readonly action: "clear_scheduled_change"; readonly kind: SubscriptionScheduledChangeKind }
  | { readonly action: "set_trial_end"; readonly end: SubscriptionTrialEnd };

export function assertSubscriptionOutcome(
  snapshot: ProviderSubscriptionSnapshot,
  expected: ExpectedOutcome,
  now: IsoDateTime,
  provider: ProviderName,
): void {
  const scheduled = snapshot.scheduledChange;
  let confirmed: boolean;
  switch (expected.action) {
    case "cancel":
      confirmed =
        expected.timing === "immediately"
          ? snapshot.status === "canceled"
          : (snapshot.status === "canceled" && expected.previous === "canceled") ||
            (snapshot.status !== "canceled" &&
              (scheduled?.kind === "cancel" ||
                (snapshot.cancelAtPeriodEnd && snapshot.currentPeriodEnd !== undefined)));
      break;
    case "pause": {
      const policy = expected.policy;
      if (policy.invoiceBehavior === "stop_billing") {
        confirmed =
          policy.timing === "immediately"
            ? snapshot.status === "paused"
            : snapshot.status !== "paused" && scheduled?.kind === "pause";
        if (policy.resumesAt !== undefined)
          confirmed &&= sameSecond(snapshot.resumesAt, policy.resumesAt);
      } else {
        confirmed =
          policy.timing === "immediately" &&
          snapshot.status !== "canceled" &&
          snapshot.collectionPause?.invoiceBehavior === policy.invoiceBehavior;
        if (policy.resumesAt !== undefined)
          confirmed &&= sameSecond(snapshot.collectionPause?.resumesAt, policy.resumesAt);
      }
      break;
    }
    case "resume":
      confirmed =
        snapshot.status !== "paused" &&
        snapshot.status !== "canceled" &&
        snapshot.status !== "unknown" &&
        snapshot.collectionPause === undefined &&
        scheduled?.kind !== "resume";
      break;
    case "clear_scheduled_change":
      confirmed =
        scheduled?.kind !== expected.kind &&
        (expected.kind !== "cancel" ||
          (!snapshot.cancelAtPeriodEnd && snapshot.status !== "canceled"));
      break;
    case "set_trial_end":
      confirmed =
        expected.end === "now"
          ? snapshot.status !== "trialing" &&
            (snapshot.trialEnd === undefined || Date.parse(snapshot.trialEnd) <= Date.parse(now))
          : sameSecond(snapshot.trialEnd, expected.end);
      break;
  }
  if (!confirmed)
    throw new PolybillError("Provider has not confirmed the requested subscription outcome", {
      code: "outcome_unknown",
      operation: `subscription.${expected.action}`,
      provider,
      retryable: false,
    });
}

function sameSecond(actual: IsoDateTime | undefined, expected: IsoDateTime): boolean {
  return (
    actual !== undefined &&
    Math.floor(Date.parse(actual) / 1000) === Math.floor(Date.parse(expected) / 1000)
  );
}
