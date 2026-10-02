import { type ProviderAdapter, type SubscriptionProvider } from "@polybill/adapter-kit";
import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it, vi } from "vitest";
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
  lemonSubscription,
  lemonAttributes,
  later,
} from "./subscription-fixtures.js";

const immediate = { timing: "immediately", proration: "prorate_immediately" } as const;
const preflights: readonly {
  adapter: ProviderAdapter;
  response: unknown;
  id: string;
  invoke: (
    port: SubscriptionProvider,
    context: ReturnType<typeof subscriptionContext>,
    id: string,
  ) => unknown;
}[] = [
  {
    adapter: createPolarAdapter(),
    response: { ...polarSubscription, id: "foreign" },
    id: "sub_fixture",
    invoke: (port, ctx, id) =>
      port.changeItems?.(ctx, id, {
        items: [{ externalPriceId: "prod_fixture", quantity: 4 }],
        policy: immediate,
      }),
  },
  {
    adapter: createDodoAdapter(),
    response: { ...dodoSubscription, subscription_id: "foreign" },
    id: "sub_fixture",
    invoke: (port, ctx, id) =>
      port.changeItems?.(ctx, id, {
        items: [{ externalPriceId: "prod_fixture", quantity: 4 }],
        policy: immediate,
      }),
  },
  {
    adapter: createCreemAdapter(),
    response: { ...creemSubscription, id: "foreign" },
    id: "sub_fixture",
    invoke: (port, ctx, id) =>
      port.changeItems?.(ctx, id, {
        items: [{ externalPriceId: "prod_fixture", quantity: 4 }],
        policy: immediate,
      }),
  },
  {
    adapter: createStripeAdapter(),
    response: { ...stripeSubscription, id: "foreign" },
    id: "sub_fixture",
    invoke: (port, ctx, id) =>
      port.changeItems?.(ctx, id, {
        items: [{ externalPriceId: "price_fixture", quantity: 4 }],
        policy: immediate,
      }),
  },
  {
    adapter: createPaddleAdapter(),
    response: { data: { ...paddleSubscription, id: "foreign", status: "trialing" } },
    id: "sub_fixture",
    invoke: (port, ctx, id) => port.setTrialEnd?.(ctx, id, "now"),
  },
  {
    adapter: createLemonSqueezyAdapter(),
    response: { data: { ...lemonSubscription().data, id: "99" } },
    id: "84",
    invoke: (port, ctx, id) =>
      port.changeItems?.(ctx, id, {
        items: [{ externalPriceId: "21", quantity: 4 }],
        policy: immediate,
      }),
  },
];

describe("subscription review regressions", () => {
  it("observes and clears a Stripe cancellation at an explicit date", async () => {
    const url = "https://api.stripe.com/v1/subscriptions/sub_fixture";
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url,
        response: Response.json({ ...stripeSubscription, cancel_at: Date.parse(later) / 1000 }),
      },
      { method: "POST", url, response: Response.json(stripeSubscription) },
    ]);
    const ctx = subscriptionContext("stripe", scripted.fetch);
    const port = createStripeAdapter().subscriptions;
    await expect(port?.get?.(ctx, "sub_fixture")).resolves.toMatchObject({
      value: { scheduledChange: { kind: "cancel", effectiveAt: later } },
    });
    const cleared = await port?.clearScheduledChange?.(ctx, "sub_fixture", "cancel");
    expect(cleared?.value.scheduledChange).toBeUndefined();
    const body = new URLSearchParams(await scripted.requests[1]?.text());
    expect(body.get("cancel_at")).toBe("");
    expect(body.get("cancel_at_period_end")).toBe("false");
    scripted.assertConsumed();
  });

  it.each(preflights)(
    "rejects a foreign preflight for $adapter.descriptor.name before mutation",
    async ({ adapter, response, invoke, id }) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
      const ctx = subscriptionContext(adapter.descriptor.name, fetch);
      if (adapter.subscriptions === undefined) throw new Error("Subscription port missing");
      await expect(invoke(adapter.subscriptions, ctx, id)).rejects.toMatchObject({
        code: "provider_response_invalid",
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    },
  );

  it("rejects a Lemon quantity item owned by a different subscription", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        lemonSubscription({
          ...lemonAttributes,
          first_subscription_item: { id: 100, quantity: 2, subscription_id: 99 },
        }),
      ),
    );
    await expect(
      createLemonSqueezyAdapter().subscriptions?.changeItems?.(
        subscriptionContext("lemonSqueezy", fetch),
        "84",
        {
          items: [{ externalPriceId: "21", quantity: 4 }],
          policy: immediate,
        },
      ),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["prod_fixture", "prod_upgrade"])(
    "rejects multi-item Creem replacement of %s before any write",
    async (product) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          ...creemSubscription,
          items: [
            ...creemSubscription.items,
            { id: "sitem_addon", product_id: "prod_addon", units: 1 },
          ],
        }),
      );
      await expect(
        createCreemAdapter().subscriptions?.changeItems?.(
          subscriptionContext("creem", fetch),
          "sub_fixture",
          {
            items: [{ externalPriceId: product, quantity: 2 }],
            policy: immediate,
          },
        ),
      ).rejects.toMatchObject({ code: "unsupported_capability" });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("retains Paddle's automatic resume when already paused", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          ...paddleSubscription,
          status: "paused",
          current_billing_period: null,
          scheduled_change: { action: "resume", effective_at: later, resume_at: null },
        },
      }),
    );
    await expect(
      createPaddleAdapter().subscriptions?.get?.(
        subscriptionContext("paddle", fetch),
        "sub_fixture",
      ),
    ).resolves.toMatchObject({
      value: { resumesAt: later, scheduledChange: { kind: "resume", effectiveAt: later } },
    });
  });

  it("loads every Stripe item before replacement and explicitly removes a paginated item", async () => {
    const url = "https://api.stripe.com/v1/subscriptions/sub_fixture";
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url,
        response: Response.json({
          ...stripeSubscription,
          items: { ...stripeSubscription.items, has_more: true },
        }),
      },
      {
        method: "GET",
        url: "https://api.stripe.com/v1/subscription_items?subscription=sub_fixture&limit=100&starting_after=si_fixture",
        response: Response.json({
          has_more: false,
          data: [
            {
              id: "si_extra",
              subscription: "sub_fixture",
              price: { id: "price_extra" },
              quantity: 1,
            },
          ],
        }),
      },
      { method: "POST", url, response: Response.json(stripeSubscription) },
    ]);
    await createStripeAdapter().subscriptions?.changeItems?.(
      subscriptionContext("stripe", scripted.fetch),
      "sub_fixture",
      {
        items: [{ externalPriceId: "price_fixture", quantity: 2 }],
        policy: immediate,
      },
    );
    const body = new URLSearchParams(await scripted.requests[2]?.text());
    expect(body.get("items[1][id]")).toBe("si_extra");
    expect(body.get("items[1][deleted]")).toBe("true");
    scripted.assertConsumed();
  });

  it.each([
    { has_more: true, data: [] },
    { has_more: false, data: [{ id: "si_fixture", subscription: "sub_fixture" }] },
    { has_more: false, data: [{ id: "si_extra", subscription: "foreign" }] },
  ])("rejects broken Stripe pagination before mutation", async (page) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...stripeSubscription,
          items: { ...stripeSubscription.items, has_more: true },
        }),
      )
      .mockResolvedValueOnce(Response.json(page));
    await expect(
      createStripeAdapter().subscriptions?.changeItems?.(
        subscriptionContext("stripe", fetch),
        "sub_fixture",
        {
          items: [{ externalPriceId: "price_fixture", quantity: 2 }],
          policy: immediate,
        },
      ),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });
});
