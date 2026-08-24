import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createStripeAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_stripemig1", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_stripemig1", "conn"),
  tenantId,
  provider: "stripe",
  environment: "test",
};

describe("Stripe migration source", () => {
  it("scans authoritative pages and rejects unsupported entities before transport", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://api.stripe.com/v1/products?limit=100",
        response: Response.json({
          object: "list",
          data: [{ id: "prod_1", name: "One" }],
          has_more: true,
        }),
      },
      {
        method: "GET",
        url: "https://api.stripe.com/v1/products?limit=100&starting_after=prod_1",
        response: Response.json({
          object: "list",
          data: [{ id: "prod_2", name: "Two" }],
          has_more: false,
        }),
      },
    ]);
    const source = createStripeAdapter().migration;
    if (source === undefined) throw new Error("Stripe migration source is missing");

    const first = await source.scan(context(scripted.fetch), "product");
    expect(first).toMatchObject({ items: [{ id: "prod_1" }], nextCursor: "prod_1" });
    await expect(
      source.scan(context(scripted.fetch), "product", first.nextCursor),
    ).resolves.toEqual({ items: [{ id: "prod_2", name: "Two" }] });
    await expect(source.scan(context(scripted.fetch), "license")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "sk_test_migration" },
    requestId: parseId<"RequestId">("req_stripemig1", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
