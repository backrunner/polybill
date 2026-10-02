import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import type { ProviderAdapter } from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createCreemAdapter } from "../../provider-creem/src/index.js";
import { createPaddleAdapter } from "../../provider-paddle/src/index.js";
import { createStripeAdapter } from "../../provider-stripe/src/index.js";
import { createLemonSqueezyAdapter } from "../../provider-lemonsqueezy/src/index.js";
import { subscriptionContext, now } from "./subscription-fixtures.js";

const cases: readonly { adapter: ProviderAdapter; types: readonly string[] }[] = [
  {
    adapter: createPolarAdapter({ apiVersion: "2027-01" }),
    types: [
      "subscription.active",
      "subscription.cycled",
      "subscription.migrated",
      "subscription.past_due",
      "subscription.paused",
      "subscription.resumed",
      "subscription.uncanceled",
    ],
  },
  {
    adapter: createDodoAdapter(),
    types: [
      "subscription.renewed",
      "subscription.on_hold",
      "subscription.paused",
      "subscription.unpaused",
      "subscription.past_due",
      "subscription.update_payment_method",
      "subscription.failed",
      "subscription.expired",
      "subscription.plan_changed",
      "subscription.updated",
    ],
  },
  {
    adapter: createCreemAdapter(),
    types: [
      "subscription.trialing",
      "subscription.paused",
      "subscription.update",
      "subscription.scheduled_cancel",
      "subscription.unpaid",
      "subscription.expired",
    ],
  },
  {
    adapter: createPaddleAdapter(),
    types: [
      "subscription.activated",
      "subscription.trialing",
      "subscription.paused",
      "subscription.resumed",
      "subscription.past_due",
    ],
  },
  {
    adapter: createStripeAdapter(),
    types: [
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "customer.subscription.trial_will_end",
      "customer.subscription.pending_update_applied",
      "customer.subscription.pending_update_expired",
    ],
  },
  {
    adapter: createLemonSqueezyAdapter(),
    types: ["subscription_resumed", "subscription_paused", "subscription_unpaused"],
  },
];

describe("signed subscription lifecycle events", () => {
  for (const { adapter, types } of cases) {
    it.each(types)(
      `${adapter.descriptor.name} retains %s as subscription evidence`,
      async (type) => {
        const provider = adapter.descriptor.name;
        const ctx = subscriptionContext(provider, createScriptedFetch([]).fetch);
        const stamp = Date.parse(now) / 1000;
        const key = "subscription-fixture-secret";
        const resource = {
          id: "sub_remote",
          subscription_id: "sub_remote",
          status: "active",
          updated_at: now,
        };
        const body =
          provider === "stripe"
            ? {
                id: "evt_fixture",
                type,
                livemode: false,
                data: { object: resource },
                created: stamp,
              }
            : provider === "paddle"
              ? { event_id: "evt_fixture", event_type: type, occurred_at: now, data: resource }
              : provider === "creem"
                ? { id: "evt_fixture", eventType: type, created_at: stamp * 1000, object: resource }
                : provider === "lemonSqueezy"
                  ? {
                      meta: { event_name: type, test_mode: true },
                      data: { id: "sub_remote", attributes: resource },
                    }
                  : { type, timestamp: now, api_version: "2027-01", data: resource };
        const rawBody = new TextEncoder().encode(JSON.stringify(body));
        const sign = (prefix = "", encoding: "hex" | "base64" = "hex") =>
          createHmac("sha256", key).update(prefix).update(rawBody).digest(encoding);
        const headers =
          provider === "stripe"
            ? new Headers({ "stripe-signature": `t=${stamp},v1=${sign(`${stamp}.`)}` })
            : provider === "paddle"
              ? new Headers({ "paddle-signature": `ts=${stamp};h1=${sign(`${stamp}:`)}` })
              : provider === "creem"
                ? new Headers({ "creem-signature": sign() })
                : provider === "lemonSqueezy"
                  ? new Headers({ "x-signature": sign() })
                  : new Headers({
                      "webhook-id": "evt_fixture",
                      "webhook-timestamp": String(stamp),
                      "webhook-signature": `v1,${sign(`evt_fixture.${stamp}.`, "base64")}`,
                    });
        const input = {
          rawBody,
          headers,
          environment: "test" as const,
          now: parseIsoDateTime(now),
          secret: {
            active: provider === "dodo" ? `whsec_${Buffer.from(key).toString("base64")}` : key,
            activeKeyId: "fixture",
          },
        };
        const verified = await adapter.webhooks.verify(input);
        expect((await adapter.webhooks.verify(input)).deliveryKey).toBe(verified.deliveryKey);
        await expect(
          adapter.webhooks.verify({
            ...input,
            rawBody: new TextEncoder().encode(JSON.stringify({ ...body, changed: true })),
          }),
        ).rejects.toMatchObject({ code: "signature_invalid" });
        const decoded = adapter.webhooks.decode(verified);
        const events = await adapter.webhooks.map(decoded, {
          ...ctx,
          observedAt: ctx.clock.now(),
          lookup: {
            findCanonicalId: async ({ entityType, externalId }) =>
              entityType === "subscription" && externalId === "sub_remote"
                ? "sub_canonical"
                : undefined,
          },
        });
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toMatch(/^subscription\.(changed|past_due|canceled)\.v1$/);
        if (provider === "creem" && type === "subscription.expired")
          expect(events[0]?.type).toBe("subscription.changed.v1");
        if (provider === "dodo" && type === "subscription.on_hold")
          expect(events[0]?.type).toBe("subscription.changed.v1");
        if (type === "subscription.past_due")
          expect(events[0]?.type).toBe("subscription.past_due.v1");
        expect(decoded.externalIds.object).toBe("sub_remote");
      },
    );
  }
});
