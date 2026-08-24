import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_polarmig1", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_polarmig1", "conn"),
  tenantId,
  provider: "polar",
  environment: "test",
};

describe("Polar migration source", () => {
  it("validates page metadata and reconstructs list requests", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://sandbox-api.polar.sh/v1/products/?page=1&limit=100",
        response: Response.json({
          items: [{ id: "prod_1" }],
          pagination: { total_count: 2, max_page: 2 },
        }),
      },
      {
        method: "GET",
        url: "https://sandbox-api.polar.sh/v1/products/?page=2&limit=100",
        response: Response.json({
          items: [{ id: "prod_2" }],
          pagination: { total_count: 2, max_page: 2 },
        }),
      },
    ]);
    const source = createPolarAdapter().migration;
    if (source === undefined) throw new Error("Polar migration source is missing");
    const first = await source.scan(context(scripted.fetch), "product");
    expect(first).toMatchObject({ items: [{ id: "prod_1" }], nextCursor: "2" });
    await expect(source.scan(context(scripted.fetch), "price", first.nextCursor)).resolves.toEqual({
      items: [{ id: "prod_2" }],
    });
    await expect(source.scan(context(scripted.fetch), "voucher")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { accessToken: "polar_migration_token" },
    requestId: parseId<"RequestId">("req_polarmig01", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
