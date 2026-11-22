import { createScriptedFetch } from "@polybill/testing";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createCreemAdapter } from "../../provider-creem/src/index.js";
import { createPaddleAdapter } from "../../provider-paddle/src/index.js";
import { createStripeAdapter } from "../../provider-stripe/src/index.js";
import { createLemonSqueezyAdapter } from "../../provider-lemonsqueezy/src/index.js";
import {
  subscriptionContext,
  polarSubscription,
  dodoSubscription,
  creemSubscription,
  paddleSubscription,
  stripeSubscription,
  lemonAttributes,
  lemonSubscription,
  end,
  later,
} from "./subscription-fixtures.js";

describe("subscription policies across providers", () => {
  it("reads an ended trial and protects a pending discount from item mutations", async () => {
    const url = "https://sandbox-api.polar.sh/v1/subscriptions/sub_fixture";
    const response = Response.json(
      {
        ...polarSubscription,
        status: "trial_ended",
        pending_update: {
          applies_at: end,
          product_id: null,
          seats: null,
          units: null,
          discount_id: null,
          discount_unset: true,
        },
      },
      { headers: { "Polar-Version": "2027-01" } },
    );
    const script = createScriptedFetch([
      { method: "GET", url, response },
      { method: "GET", url, response },
      { method: "GET", url, response },
    ]);
    const port = createPolarAdapter({ apiVersion: "2027-01" }).subscriptions;
    const ctx = subscriptionContext("polar", script.fetch);
    const snapshot = await port?.get?.(ctx, "sub_fixture");
    expect(snapshot?.value).toMatchObject({ status: "incomplete", rawStatus: "trial_ended" });
    expect(snapshot?.value.scheduledChange).toBeUndefined();
    await expect(port?.clearScheduledChange?.(ctx, "sub_fixture", "items")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(
      port?.changeItems?.(ctx, "sub_fixture", {
        items: [{ externalPriceId: "prod_fixture", quantity: 3 }],
        policy: { timing: "period_end", proration: "none" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    script.assertConsumed();
  });

  it.each(["2026-10", "2027-01"] as const)(
    "Polar %s schedules seats without granting them early and can clear them",
    async (apiVersion) => {
      const pending = {
        ...polarSubscription,
        pending_update: { applies_at: end, product_id: null, seats: 5, units: null },
      };
      const scripted = createScriptedFetch([
        {
          method: "GET",
          url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_fixture",
          response: Response.json(polarSubscription, { headers: { "Polar-Version": apiVersion } }),
        },
        {
          method: "PATCH",
          url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_fixture",
          response: Response.json(pending, { headers: { "Polar-Version": apiVersion } }),
        },
        ...(apiVersion === "2027-01"
          ? [
              {
                method: "GET" as const,
                url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_fixture",
                response: Response.json(pending, { headers: { "Polar-Version": apiVersion } }),
              },
            ]
          : []),
        {
          method: "PATCH",
          url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_fixture",
          response: Response.json(polarSubscription, { headers: { "Polar-Version": apiVersion } }),
        },
      ]);
      const port = createPolarAdapter({ apiVersion }).subscriptions;
      const ctx = subscriptionContext("polar", scripted.fetch);
      await expect(
        port?.changeItems?.(ctx, "sub_fixture", {
          items: [{ externalPriceId: "prod_fixture", quantity: 5 }],
          policy: { timing: "period_end", proration: "none" },
        }),
      ).resolves.toMatchObject({
        value: {
          items: [{ quantity: 2 }],
          scheduledChange: { kind: "items", effectiveAt: end, items: [{ quantity: 5 }] },
        },
      });
      expect(await scripted.requests[1]?.json()).toEqual({
        seats: 5,
        proration_behavior: "next_period",
      });
      await expect(
        port?.clearScheduledChange?.(ctx, "sub_fixture", "items"),
      ).resolves.toMatchObject({ value: { items: [{ quantity: 2 }] } });
      expect(await scripted.requests.at(-1)?.json()).toEqual({ pending_update: null });
      for (const request of scripted.requests)
        expect(request.headers.get("Polar-Version")).toBe(apiVersion);
      scripted.assertConsumed();
    },
  );

  it("Dodo preserves add-ons, prevents unpaid changes and reads back scheduled changes", async () => {
    const scheduled = {
      ...dodoSubscription,
      scheduled_change: { effective_at: end, product_id: "prod_next", quantity: 4 },
    };
    const url = "https://test.dodopayments.com/subscriptions/sub_fixture";
    const scripted = createScriptedFetch([
      { method: "GET", url, response: Response.json(dodoSubscription) },
      { method: "POST", url: `${url}/change-plan`, response: Response.json({ payment_id: null }) },
      { method: "GET", url, response: Response.json(scheduled) },
      {
        method: "DELETE",
        url: `${url}/change-plan/scheduled`,
        response: new Response(null, { status: 204 }),
      },
      { method: "GET", url, response: Response.json(dodoSubscription) },
    ]);
    const port = createDodoAdapter().subscriptions;
    const ctx = subscriptionContext("dodo", scripted.fetch);
    await expect(
      port?.changeItems?.(ctx, "sub_fixture", {
        items: [{ externalPriceId: "prod_next", quantity: 4 }],
        policy: { timing: "period_end", proration: "none" },
      }),
    ).resolves.toMatchObject({
      value: {
        items: [{ externalPriceId: "prod_fixture", quantity: 2 }],
        scheduledChange: { kind: "items", items: [{ externalPriceId: "prod_next", quantity: 4 }] },
      },
    });
    expect(await scripted.requests[1]?.json()).toEqual({
      product_id: "prod_next",
      quantity: 4,
      effective_at: "next_billing_date",
      proration_billing_mode: "do_not_bill",
      on_payment_failure: "prevent_change",
      addons: [{ addon_id: "addon_fixture", quantity: 3 }],
    });
    const cleared = await port?.clearScheduledChange?.(ctx, "sub_fixture", "items");
    expect(cleared?.value.scheduledChange).toBeUndefined();
    scripted.assertConsumed();
  });

  it("Creem updates the existing seat item and reverses scheduled cancellation", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/subscriptions?subscription_id=sub_fixture",
        response: Response.json(creemSubscription),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/subscriptions/sub_fixture",
        response: Response.json({
          ...creemSubscription,
          items: [
            {
              id: "sitem_fixture",
              product_id: "prod_fixture",
              price_id: "price_fixture",
              units: 5,
            },
          ],
        }),
      },
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/subscriptions?subscription_id=sub_fixture",
        response: Response.json({ ...creemSubscription, status: "scheduled_cancel" }),
      },
      {
        method: "POST",
        url: "https://test-api.creem.io/v1/subscriptions/sub_fixture/resume",
        response: Response.json(creemSubscription),
      },
    ]);
    const port = createCreemAdapter().subscriptions;
    const ctx = subscriptionContext("creem", scripted.fetch);
    await expect(
      port?.changeItems?.(ctx, "sub_fixture", {
        items: [{ externalPriceId: "prod_fixture", quantity: 5 }],
        policy: { timing: "immediately", proration: "prorate_next_invoice" },
      }),
    ).resolves.toMatchObject({
      value: { items: [{ externalPriceId: "prod_fixture", quantity: 5 }] },
    });
    expect(await scripted.requests[1]?.json()).toEqual({
      items: [{ id: "sitem_fixture", units: 5 }],
      update_behavior: "proration-charge",
    });
    await expect(port?.clearScheduledChange?.(ctx, "sub_fixture", "cancel")).resolves.toMatchObject(
      { value: { status: "active", cancelAtPeriodEnd: false } },
    );
    scripted.assertConsumed();
  });

  it("Creem cancellation reversal does not accidentally resume a billing pause", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/subscriptions?subscription_id=sub_fixture",
        response: Response.json({ ...creemSubscription, status: "paused" }),
      },
    ]);
    await expect(
      createCreemAdapter().subscriptions?.clearScheduledChange?.(
        subscriptionContext("creem", scripted.fetch),
        "sub_fixture",
        "cancel",
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(scripted.requests).toHaveLength(1);
    scripted.assertConsumed();
  });

  it("Paddle retains scheduled pause timing and extends a trial without proration", async () => {
    const url = "https://sandbox-api.paddle.com/subscriptions/sub_fixture";
    const pending = {
      ...paddleSubscription,
      scheduled_change: { action: "pause", effective_at: end, resume_at: later },
    };
    const scripted = createScriptedFetch([
      { method: "POST", url: `${url}/pause`, response: Response.json({ data: pending }) },
      { method: "GET", url, response: Response.json({ data: pending }) },
      { method: "PATCH", url, response: Response.json({ data: paddleSubscription }) },
      {
        method: "GET",
        url,
        response: Response.json({ data: { ...paddleSubscription, status: "trialing" } }),
      },
      {
        method: "PATCH",
        url,
        response: Response.json({
          data: { ...paddleSubscription, status: "trialing", next_billed_at: later },
        }),
      },
    ]);
    const port = createPaddleAdapter().subscriptions;
    const ctx = subscriptionContext("paddle", scripted.fetch);
    await expect(
      port?.pause?.(ctx, "sub_fixture", {
        timing: "period_end",
        invoiceBehavior: "stop_billing",
        resumesAt: parseIsoDateTime(later),
      }),
    ).resolves.toMatchObject({
      value: {
        status: "active",
        scheduledChange: { kind: "pause", effectiveAt: end },
        resumesAt: later,
      },
    });
    expect(await scripted.requests[0]?.json()).toEqual({
      effective_from: "next_billing_period",
      resume_at: later,
    });
    await port?.clearScheduledChange?.(ctx, "sub_fixture", "pause");
    expect(await scripted.requests[2]?.json()).toEqual({ scheduled_change: null });
    await expect(
      port?.setTrialEnd?.(ctx, "sub_fixture", parseIsoDateTime(later)),
    ).resolves.toMatchObject({ value: { trialEnd: later } });
    expect(await scripted.requests[4]?.json()).toEqual({
      next_billed_at: later,
      proration_billing_mode: "do_not_bill",
    });
    scripted.assertConsumed();
  });

  it("Stripe keeps unpaid and collection pauses distinct and reads Basil item period dates", async () => {
    const url = "https://api.stripe.com/v1/subscriptions/sub_fixture";
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url,
        response: Response.json({
          ...stripeSubscription,
          status: "unpaid",
          pause_collection: { behavior: "keep_as_draft", resumes_at: Date.parse(later) / 1000 },
        }),
      },
      { method: "GET", url, response: Response.json({ ...stripeSubscription, status: "paused" }) },
      { method: "POST", url: `${url}/resume`, response: Response.json(stripeSubscription) },
    ]);
    const port = createStripeAdapter().subscriptions;
    const ctx = subscriptionContext("stripe", scripted.fetch);
    await expect(port?.get?.(ctx, "sub_fixture")).resolves.toMatchObject({
      value: {
        status: "unpaid",
        currentPeriodEnd: end,
        collectionPause: { invoiceBehavior: "keep_draft", resumesAt: later },
      },
    });
    await expect(port?.resume?.(ctx, "sub_fixture")).resolves.toMatchObject({
      value: { status: "active" },
    });
    expect(await scripted.requests[2]?.text()).toBe(
      "billing_cycle_anchor=now&proration_behavior=none",
    );
    scripted.assertConsumed();
  });

  it("Lemon uses subscription-item quantities and blocks PayPal server updates before mutation", async () => {
    const url = "https://api.lemonsqueezy.com/v1/subscriptions/84";
    const scripted = createScriptedFetch([
      { method: "GET", url, response: Response.json(lemonSubscription()) },
      {
        method: "PATCH",
        url: "https://api.lemonsqueezy.com/v1/subscription-items/100",
        response: Response.json({ data: { id: "100" } }),
      },
      {
        method: "GET",
        url,
        response: Response.json(
          lemonSubscription({
            ...lemonAttributes,
            first_subscription_item: { id: 100, quantity: 4 },
          }),
        ),
      },
      {
        method: "GET",
        url,
        response: Response.json(
          lemonSubscription({ ...lemonAttributes, payment_processor: "paypal" }),
        ),
      },
    ]);
    const port = createLemonSqueezyAdapter().subscriptions;
    const ctx = subscriptionContext("lemonSqueezy", scripted.fetch);
    await expect(
      port?.changeItems?.(ctx, "84", {
        items: [{ externalPriceId: "21", quantity: 4 }],
        policy: { timing: "immediately", proration: "none" },
      }),
    ).resolves.toMatchObject({ value: { items: [{ externalPriceId: "21", quantity: 4 }] } });
    expect(await scripted.requests[1]?.json()).toMatchObject({
      data: {
        id: "100",
        attributes: { quantity: 4, invoice_immediately: false, disable_prorations: true },
      },
    });
    await expect(port?.clearScheduledChange?.(ctx, "84", "cancel")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    scripted.assertConsumed();
  });
});
