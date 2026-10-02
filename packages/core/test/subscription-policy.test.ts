import { expect, it } from "vitest";
import {
  assertSubscriptionItemChangePolicy,
  assertSubscriptionPausePolicy,
  parseIsoDateTime,
} from "../src/index.js";

const now = parseIsoDateTime("2026-10-02T00:00:00.000Z");
it("rejects immediate proration of a change that only applies next period", () => {
  expect(() =>
    assertSubscriptionItemChangePolicy({ timing: "period_end", proration: "prorate_immediately" }),
  ).toThrow(RangeError);
  expect(() =>
    assertSubscriptionItemChangePolicy({ timing: "period_end", proration: "none" }),
  ).not.toThrow();
});
it("validates automatic resume without conflating invoice and billing-period pauses", () => {
  for (const invoiceBehavior of [
    "stop_billing",
    "void",
    "free",
    "keep_draft",
    "mark_uncollectible",
  ] as const)
    expect(() =>
      assertSubscriptionPausePolicy(
        {
          timing: "immediately",
          invoiceBehavior,
          resumesAt: parseIsoDateTime("2026-11-02T00:00:00.000Z"),
        },
        now,
      ),
    ).not.toThrow();
  expect(() =>
    assertSubscriptionPausePolicy(
      { timing: "immediately", invoiceBehavior: "void", resumesAt: now },
      now,
    ),
  ).toThrow(RangeError);
});
