import { createHmac } from "node:crypto";
import { parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createLemonSqueezyAdapter } from "../../provider-lemonsqueezy/src/index.js";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import {
  dodoSubscription,
  lemonAttributes,
  lemonSubscription,
  subscriptionContext,
  now,
  end,
  later,
} from "./subscription-fixtures.js";
import { setup, id } from "./subscription-state-fixture.js";

describe("official provider lifecycle contracts", () => {
  it.each([
    ["pending", "incomplete"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["on_hold", "unpaid"],
    ["paused", "paused"],
    ["cancelled", "canceled"],
    ["failed", "canceled"],
    ["expired", "canceled"],
  ])("projects Dodo %s as %s", async (rawStatus, expected) => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test.dodopayments.com/subscriptions/sub_fixture",
        response: Response.json({ ...dodoSubscription, status: rawStatus }),
      },
    ]);
    const result = await createDodoAdapter().subscriptions?.get?.(
      subscriptionContext("dodo", scripted.fetch),
      "sub_fixture",
    );
    expect(result?.value).toMatchObject({ status: expected, rawStatus });
    scripted.assertConsumed();
  });

  it("uses Lemon expiration for access cutoff and retains the separate renewal date", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/subscriptions/84",
        response: Response.json(
          lemonSubscription({
            ...lemonAttributes,
            status: "cancelled",
            cancelled: true,
            renews_at: end,
            ends_at: later,
          }),
        ),
      },
    ]);
    const result = await createLemonSqueezyAdapter().subscriptions?.get?.(
      subscriptionContext("lemonSqueezy", scripted.fetch),
      "84",
    );
    if (result === undefined) throw new Error("Missing subscription port");
    expect(result.value).toMatchObject({
      status: "active",
      currentPeriodEnd: end,
      scheduledChange: { kind: "cancel", effectiveAt: later },
    });
    const { client } = await setup(() => ({
      ...result.value,
      externalId: "remote_sub",
      externalCustomerId: "remote_customer",
      items: [{ externalPriceId: "remote_price", quantity: 2 }],
    }));
    const saved = await client.subscriptions.refresh(id, parseIdempotencyKey("lemon:cutoff"));
    expect(saved).toMatchObject({ status: "active", accessUntil: later, currentPeriodEnd: end });
    scripted.assertConsumed();
  });

  it.each(["2026-10", "2027-01"] as const)(
    "distinguishes Polar unpaid revocation from cancellation on %s",
    async (apiVersion) => {
      const adapter = createPolarAdapter({ apiVersion });
      const ctx = subscriptionContext("polar", createScriptedFetch([]).fetch);
      for (const status of ["unpaid", "canceled"] as const) {
        const stamp = Date.parse(now) / 1000;
        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            type: "subscription.revoked",
            api_version: apiVersion,
            timestamp: now,
            data: { id: "sub_remote", status },
          }),
        );
        const secret = "fixture-polar-key";
        const signature = createHmac("sha256", secret)
          .update(`evt_${status}.${stamp}.`)
          .update(rawBody)
          .digest("base64");
        const verified = await adapter.webhooks.verify({
          rawBody,
          headers: new Headers({
            "webhook-id": `evt_${status}`,
            "webhook-timestamp": String(stamp),
            "webhook-signature": `v1,${signature}`,
          }),
          environment: "test",
          secret: { active: secret, activeKeyId: "fixture" },
          now: parseIsoDateTime(now),
        });
        const events = await adapter.webhooks.map(adapter.webhooks.decode(verified), {
          ...ctx,
          observedAt: ctx.clock.now(),
          lookup: { findCanonicalId: async () => "sub_canonical" },
        });
        expect(events[0]?.type).toBe(
          status === "canceled" ? "subscription.canceled.v1" : "subscription.changed.v1",
        );
      }
    },
  );
});
