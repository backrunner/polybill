import { parseId, parseIsoDateTime } from "@polybill/core";
import type { ProviderUsageEvent } from "@polybill/adapter-kit";
import { createScriptedFetch } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { subscriptionContext, now } from "./subscription-fixtures.js";

const event: ProviderUsageEvent = {
  externalId: "polybill_event_fixture",
  externalCustomerId: "customer_fixture",
  meter: {
    id: parseId<"MeterId">("meter_fixture", "meter"),
    name: "API tokens",
    eventName: "api_tokens",
    unit: "tokens",
    aggregation: "sum",
    valueProperty: "tokens",
  },
  quantity: "125",
  occurredAt: parseIsoDateTime(now),
};
const query = new URLSearchParams({
  customer_id: event.externalCustomerId,
  name: event.meter.eventName,
  source: "user",
  "metadata[polybill_event_id]": event.externalId,
  limit: "2",
});
const item = {
  id: "remote_event",
  source: "user",
  customer_id: event.externalCustomerId,
  name: event.meter.eventName,
  timestamp: "2026-10-02T00:00:00Z",
  metadata: { tokens: 125, polybill_event_id: event.externalId },
};

describe("Polar authoritative usage recovery", () => {
  it.each(["2026-10", "2027-01"] as const)(
    "reads the complete event before accepting a duplicate with API date %s",
    async (apiVersion) => {
      const headers = { "Polar-Version": apiVersion };
      const scripted = createScriptedFetch([
        {
          method: "POST",
          url: "https://sandbox-api.polar.sh/v1/events/ingest",
          response: Response.json({ inserted: 0, duplicates: 1 }, { headers }),
        },
        {
          method: "GET",
          url: `https://sandbox-api.polar.sh/v1/events/?${query}`,
          response: Response.json(
            { items: [item], pagination: { total_count: 1, max_page: 1 } },
            { headers },
          ),
        },
      ]);
      await createPolarAdapter({ apiVersion }).usage?.ingest(
        subscriptionContext("polar", scripted.fetch),
        event,
      );
      expect(scripted.requests.map((request) => request.headers.get("Polar-Version"))).toEqual([
        apiVersion,
        apiVersion,
      ]);
      scripted.assertConsumed();
    },
  );
  it("leaves a not-yet-visible event unknown without another ingestion", async () => {
    const scripted = readFixture([]);
    expect(
      await createPolarAdapter().usage?.findEvent?.(
        subscriptionContext("polar", scripted.fetch),
        event,
      ),
    ).toBe(false);
    scripted.assertConsumed();
  });
  it.each([
    { ...item, customer_id: "foreign_customer" },
    { ...item, metadata: { tokens: 126, polybill_event_id: event.externalId } },
    { ...item, metadata: { tokens: 125, polybill_event_id: "foreign_event" } },
    { ...item, timestamp: "2026-10-01T00:00:00Z" },
  ])("rejects a mismatched event %#", async (value) => {
    const scripted = readFixture([value]);
    await expect(
      createPolarAdapter().usage?.findEvent?.(subscriptionContext("polar", scripted.fetch), event),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
  it("rejects multiple events with the same marker", async () => {
    const scripted = readFixture([item, { ...item, id: "other_event" }]);
    await expect(
      createPolarAdapter().usage?.findEvent?.(subscriptionContext("polar", scripted.fetch), event),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
  it("rejects the reserved recovery metadata property before transport", async () => {
    const scripted = createScriptedFetch([]);
    await expect(
      createPolarAdapter().usage?.ingest(subscriptionContext("polar", scripted.fetch), {
        ...event,
        meter: { ...event.meter, valueProperty: "polybill_event_id" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(scripted.requests).toHaveLength(0);
  });
  it("rejects contradictory ingestion counters", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://sandbox-api.polar.sh/v1/events/ingest",
        response: Response.json(
          { inserted: 1, duplicates: 1 },
          { headers: { "Polar-Version": "2026-10" } },
        ),
      },
    ]);
    await expect(
      createPolarAdapter().usage?.ingest(subscriptionContext("polar", scripted.fetch), event),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
});

function readFixture(items: readonly unknown[]) {
  return createScriptedFetch([
    {
      method: "GET",
      url: `https://sandbox-api.polar.sh/v1/events/?${query}`,
      response: Response.json(
        { items, pagination: { total_count: items.length, max_page: items.length === 0 ? 0 : 1 } },
        { headers: { "Polar-Version": "2026-10" } },
      ),
    },
  ]);
}
