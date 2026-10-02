import { parseId, parseIsoDateTime, type UsageMeter } from "@polybill/core";
import type { ProviderUsageEvent } from "@polybill/adapter-kit";
import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createStripeAdapter } from "../../provider-stripe/src/index.js";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { subscriptionContext, now } from "./subscription-fixtures.js";

const meter: UsageMeter = {
  id: parseId<"MeterId">("meter_fixture", "meter"),
  name: "API tokens",
  eventName: "api_tokens",
  unit: "tokens",
  aggregation: "sum",
  valueProperty: "tokens",
};
const event: ProviderUsageEvent = {
  externalId: "polybill_event_fixture",
  externalCustomerId: "customer_fixture",
  meter,
  quantity: "125",
  occurredAt: parseIsoDateTime(now),
};

describe("official provider usage contracts", () => {
  it("creates a Stripe meter with explicit mappings and sends the original integer string", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://api.stripe.com/v1/billing/meters",
        response: Response.json({
          id: "meter_remote",
          event_name: "api_tokens",
          default_aggregation: { formula: "sum" },
          customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
          value_settings: { event_payload_key: "tokens" },
        }),
      },
      {
        method: "POST",
        url: "https://api.stripe.com/v1/billing/meter_events",
        response: Response.json({
          identifier: event.externalId,
          event_name: meter.eventName,
          timestamp: Date.parse(now) / 1000,
          payload: { stripe_customer_id: event.externalCustomerId, tokens: "9007199254740993" },
        }),
      },
    ]);
    const usage = createStripeAdapter().usage;
    if (usage === undefined) throw new Error("Missing usage port");
    const context = subscriptionContext("stripe", scripted.fetch);
    await usage.createMeter(context, meter);
    await usage.ingest(context, { ...event, quantity: "9007199254740993" });
    const first = new URLSearchParams(await scripted.requests[0]?.text());
    const second = new URLSearchParams(await scripted.requests[1]?.text());
    expect(first.get("customer_mapping[event_payload_key]")).toBe("stripe_customer_id");
    expect(first.get("value_settings[event_payload_key]")).toBe("tokens");
    expect(second.get("payload[tokens]")).toBe("9007199254740993");
    expect(second.get("identifier")).toBe(event.externalId);
    scripted.assertConsumed();
  });
  it.each(["2026-10", "2027-01"] as const)(
    "pins Polar %s for both meter creation and ingestion",
    async (apiVersion) => {
      const filter = {
        conjunction: "and",
        clauses: [{ property: "name", operator: "eq", value: "api_tokens" }],
      };
      const scripted = createScriptedFetch([
        {
          method: "POST",
          url: "https://sandbox-api.polar.sh/v1/meters/",
          response: Response.json(
            { id: "meter_remote", aggregation: { func: "sum", property: "tokens" }, filter },
            { headers: { "Polar-Version": apiVersion } },
          ),
        },
        {
          method: "POST",
          url: "https://sandbox-api.polar.sh/v1/events/ingest",
          response: Response.json(
            { inserted: 1, duplicates: 0 },
            { headers: { "Polar-Version": apiVersion } },
          ),
        },
      ]);
      const usage = createPolarAdapter({ apiVersion }).usage;
      if (usage === undefined) throw new Error("Missing usage port");
      const context = subscriptionContext("polar", scripted.fetch);
      await usage.createMeter(context, meter);
      await usage.ingest(context, event);
      expect(
        scripted.requests.every((request) => request.headers.get("Polar-Version") === apiVersion),
      ).toBe(true);
      expect(await scripted.requests[0]?.json()).toMatchObject({
        filter,
        aggregation: { func: "sum", property: "tokens" },
      });
      expect(await scripted.requests[1]?.json()).toEqual({
        events: [
          {
            external_id: event.externalId,
            name: "api_tokens",
            customer_id: event.externalCustomerId,
            timestamp: now,
            metadata: { tokens: 125, polybill_event_id: event.externalId },
          },
        ],
      });
      scripted.assertConsumed();
    },
  );
  it("creates Dodo meter and reads back a duplicate event before accepting it", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://test.dodopayments.com/meters",
        response: Response.json({
          id: "meter_remote",
          event_name: "api_tokens",
          aggregation: { type: "sum", key: "tokens" },
        }),
      },
      {
        method: "POST",
        url: "https://test.dodopayments.com/events/ingest",
        response: Response.json({ ingested_count: 0 }),
      },
      {
        method: "GET",
        url: `https://test.dodopayments.com/events/${event.externalId}`,
        response: Response.json({
          event_id: event.externalId,
          customer_id: event.externalCustomerId,
          event_name: "api_tokens",
          timestamp: "2026-10-02T00:00:00Z",
          metadata: { tokens: 125 },
        }),
      },
    ]);
    const usage = createDodoAdapter().usage;
    if (usage === undefined) throw new Error("Missing usage port");
    const context = subscriptionContext("dodo", scripted.fetch);
    await usage.createMeter(context, meter);
    await usage.ingest(context, event);
    expect(await scripted.requests[0]?.json()).toEqual({
      name: "API tokens",
      event_name: "api_tokens",
      measurement_unit: "tokens",
      aggregation: { type: "sum", key: "tokens" },
    });
    expect(await scripted.requests[1]?.json()).toEqual({
      events: [
        {
          event_id: event.externalId,
          customer_id: event.externalCustomerId,
          event_name: "api_tokens",
          timestamp: now,
          metadata: { tokens: 125 },
        },
      ],
    });
    scripted.assertConsumed();
  });
  it("does not accept a Dodo event bound to a different customer", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: `https://test.dodopayments.com/events/${event.externalId}`,
        response: Response.json({
          event_id: event.externalId,
          customer_id: "foreign_customer",
          event_name: "api_tokens",
          timestamp: now,
          metadata: { tokens: 125 },
        }),
      },
    ]);
    await expect(
      createDodoAdapter().usage?.findEvent?.(subscriptionContext("dodo", scripted.fetch), event),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
  it.each(["dodo", "polar"] as const)(
    "rejects unsafe numeric metadata for %s before transport",
    async (provider) => {
      const scripted = createScriptedFetch([]);
      const adapter = provider === "dodo" ? createDodoAdapter() : createPolarAdapter();
      await expect(
        adapter.usage?.ingest(subscriptionContext(provider, scripted.fetch), {
          ...event,
          quantity: "9007199254740993",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(scripted.requests).toHaveLength(0);
    },
  );
  it.each(["dodo", "stripe"] as const)(
    "rejects out-of-window %s events before transport",
    async (provider) => {
      const scripted = createScriptedFetch([]);
      const adapter = provider === "dodo" ? createDodoAdapter() : createStripeAdapter();
      await expect(
        adapter.usage?.ingest(subscriptionContext(provider, scripted.fetch), {
          ...event,
          occurredAt: parseIsoDateTime("2026-08-01T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(scripted.requests).toHaveLength(0);
    },
  );
});
