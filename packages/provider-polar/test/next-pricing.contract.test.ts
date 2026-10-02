import { readFileSync } from "node:fs";
import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { expect, it } from "vitest";
import { createPolarAdapter } from "../src/index.js";

it("preserves Next decimal seat tiers and quantity bounds through migration evidence and subscription reads", async () => {
  const price: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/seat-price-2027-01.json", import.meta.url), "utf8"),
  );
  const product = { id: "prod_next_seats", prices: [price] };
  const subscription = {
    id: "sub_next_seats",
    customer_id: "cus_next_seats",
    product_id: product.id,
    product,
    prices: [price],
    seats: 12,
    status: "active",
    current_period_start: "2026-10-02T00:00:00.000Z",
    current_period_end: "2026-11-02T00:00:00.000Z",
    cancel_at_period_end: false,
  };
  const scripted = createScriptedFetch([
    {
      method: "GET",
      url: "https://sandbox-api.polar.sh/v1/products/?page=1&limit=100",
      response: Response.json(
        { items: [product], pagination: { total_count: 1, max_page: 1 } },
        { headers: { "Polar-Version": "2027-01" } },
      ),
    },
    {
      method: "GET",
      url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_next_seats",
      response: Response.json(subscription, { headers: { "Polar-Version": "2027-01" } }),
    },
  ]);
  const tenantId = parseId<"TenantId">("ten_nextpricing", "ten");
  const context = {
    tenantId,
    connection: {
      tenantId,
      id: parseId<"ConnectionId">("conn_nextpricing", "conn"),
      environment: "test",
      provider: "polar",
    },
    credentials: { accessToken: "polar_fixture_token" },
    requestId: parseId<"RequestId">("req_nextpricing", "req"),
    deadline: parseIsoDateTime("2026-10-02T00:01:00.000Z"),
    clock: new VirtualClock("2026-10-02T00:00:00.000Z"),
    crypto: createWebCryptoPort(),
    fetch: scripted.fetch,
  } as const;
  const adapter = createPolarAdapter({ apiVersion: "2027-01" });
  const migrated = await adapter.migration?.scan(context, "price");
  expect(migrated?.items).toEqual([product]);
  expect(migrated?.items).toMatchObject([
    {
      prices: [
        {
          minimum_units: 2,
          maximum_units: null,
          tiers: {
            tiers: [
              { unit_amount: "100.12345678901234567890123456789" },
              { unit_amount: "0.000000000000000000000000001" },
            ],
          },
        },
      ],
    },
  ]);
  await expect(adapter.subscriptions?.get?.(context, subscription.id)).resolves.toMatchObject({
    value: { items: [{ externalPriceId: product.id, quantity: 12 }] },
  });
  scripted.assertConsumed();
});
