import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createPaddleAdapter } from "../../provider-paddle/src/index.js";
import { createCreemAdapter } from "../../provider-creem/src/index.js";
import { createStripeAdapter } from "../../provider-stripe/src/index.js";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { subscriptionContext, paddleSubscription } from "./subscription-fixtures.js";

describe("subscription checkout references and resume policy", () => {
  it("Dodo resolves all subscriptions through the checkout's own payment", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test.dodopayments.com/checkouts/checkout_fixture",
        response: Response.json({
          id: "checkout_fixture",
          payment_id: "payment_fixture",
          payment_status: "succeeded",
        }),
      },
      {
        method: "GET",
        url: "https://test.dodopayments.com/payments/payment_fixture",
        response: Response.json({
          payment_id: "payment_fixture",
          checkout_session_id: "checkout_fixture",
          is_multi_subscription: true,
          subscription_id: null,
          subscription_ids: ["sub_first", "sub_second"],
        }),
      },
    ]);
    expect(
      (
        await createDodoAdapter().checkout?.get(
          subscriptionContext("dodo", scripted.fetch),
          "checkout_fixture",
        )
      )?.value.externalSubscriptionIds,
    ).toEqual(["sub_first", "sub_second"]);
    scripted.assertConsumed();
  });
  it("rejects a Dodo payment belonging to a different checkout", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test.dodopayments.com/checkouts/checkout_fixture",
        response: Response.json({
          id: "checkout_fixture",
          payment_id: "payment_fixture",
          payment_status: "succeeded",
        }),
      },
      {
        method: "GET",
        url: "https://test.dodopayments.com/payments/payment_fixture",
        response: Response.json({
          payment_id: "payment_fixture",
          checkout_session_id: "foreign_checkout",
          subscription_ids: ["foreign_subscription"],
        }),
      },
    ]);
    await expect(
      createDodoAdapter().checkout?.get(
        subscriptionContext("dodo", scripted.fetch),
        "checkout_fixture",
      ),
    ).rejects.toThrow("does not belong");
  });
  it.each(["continue_current", "restart"] as const)(
    "Paddle resumes with explicit %s billing semantics",
    async (billingPeriod) => {
      const scripted = createScriptedFetch([
        {
          method: "POST",
          url: "https://sandbox-api.paddle.com/subscriptions/sub_fixture/resume",
          response: Response.json({ data: paddleSubscription }),
        },
      ]);
      await createPaddleAdapter().subscriptions?.resumeWithPolicy?.(
        subscriptionContext("paddle", scripted.fetch),
        "sub_fixture",
        { billingPeriod },
      );
      expect(await scripted.requests[0]?.json()).toEqual({
        effective_from: "immediately",
        on_resume:
          billingPeriod === "continue_current"
            ? "continue_existing_billing_period"
            : "start_new_billing_period",
      });
      scripted.assertConsumed();
    },
  );
  it.each(["stripe", "creem", "paddle", "polar"] as const)(
    "retains %s subscription references only inside the adapter snapshot",
    async (provider) => {
      const cases = {
        stripe: {
          adapter: createStripeAdapter(),
          url: "https://api.stripe.com/v1/checkout/sessions/checkout_fixture",
          body: { id: "checkout_fixture", status: "complete", subscription: "sub_remote" },
        },
        creem: {
          adapter: createCreemAdapter(),
          url: "https://test-api.creem.io/v1/checkouts?checkout_id=checkout_fixture",
          body: { id: "checkout_fixture", status: "completed", subscription: { id: "sub_remote" } },
        },
        paddle: {
          adapter: createPaddleAdapter(),
          url: "https://sandbox-api.paddle.com/transactions/checkout_fixture",
          body: {
            data: { id: "checkout_fixture", status: "completed", subscription_id: "sub_remote" },
          },
        },
        polar: {
          adapter: createPolarAdapter({ apiVersion: "2027-01" }),
          url: "https://sandbox-api.polar.sh/v1/checkouts/checkout_fixture",
          body: { id: "checkout_fixture", status: "succeeded", subscription_id: "sub_remote" },
        },
      };
      const value = cases[provider];
      const scripted = createScriptedFetch([
        {
          method: "GET",
          url: value.url,
          response: Response.json(value.body, { headers: { "Polar-Version": "2027-01" } }),
        },
      ]);
      expect(
        (
          await value.adapter.checkout?.get(
            subscriptionContext(provider, scripted.fetch),
            "checkout_fixture",
          )
        )?.value.externalSubscriptionIds,
      ).toEqual(["sub_remote"]);
      scripted.assertConsumed();
    },
  );
});
