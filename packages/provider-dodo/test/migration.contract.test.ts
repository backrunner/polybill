import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createDodoAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_dodomig01", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_dodomig01", "conn"),
  tenantId,
  provider: "dodo",
  environment: "test",
};

describe("Dodo migration source", () => {
  it("advances page-number scans until the official empty-page terminator", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test.dodopayments.com/products?page_number=1&page_size=100",
        response: Response.json({ items: [{ product_id: "pdt_1" }] }),
      },
      {
        method: "GET",
        url: "https://test.dodopayments.com/products?page_number=2&page_size=100",
        response: Response.json({ items: [] }),
      },
    ]);
    const source = createDodoAdapter().migration;
    if (source === undefined) throw new Error("Dodo migration source is missing");
    const first = await source.scan(context(scripted.fetch), "product");
    expect(first).toEqual({ items: [{ product_id: "pdt_1" }], nextCursor: "2" });
    await expect(source.scan(context(scripted.fetch), "price", first.nextCursor)).resolves.toEqual({
      items: [],
    });
    await expect(source.scan(context(scripted.fetch), "license")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(
      source.scan(context(scripted.fetch), "product", "https://evil.example"),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    scripted.assertConsumed();
  });
});

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "dodo_migration_key" },
    requestId: parseId<"RequestId">("req_dodomig01", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
