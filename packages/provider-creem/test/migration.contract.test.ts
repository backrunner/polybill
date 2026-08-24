import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_creemmig1", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_creemmig1", "conn"),
  tenantId,
  provider: "creem",
  environment: "test",
};

describe("Creem migration source", () => {
  it("uses the test API and validated page-number cursors", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/products/search?page_number=1&page_size=100",
        response: Response.json(page([{ id: "prod_1" }], 1, 2)),
      },
      {
        method: "GET",
        url: "https://test-api.creem.io/v1/products/search?page_number=2&page_size=100",
        response: Response.json(page([{ id: "prod_2" }], 2, null)),
      },
    ]);
    const source = createCreemAdapter().migration;
    if (source === undefined) throw new Error("Creem migration source is missing");

    await expect(source.scan(context(scripted.fetch), "product")).resolves.toMatchObject({
      items: [{ id: "prod_1" }],
      nextCursor: "2",
    });
    await expect(source.scan(context(scripted.fetch), "price", "2")).resolves.toEqual({
      items: [{ id: "prod_2" }],
    });
    await expect(source.scan(context(scripted.fetch), "voucher")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(
      source.scan(context(scripted.fetch), "product", "https://evil.example"),
    ).rejects.toThrow(/cursor/);
    scripted.assertConsumed();
  });
});

function page(items: readonly unknown[], current: number, next: number | null) {
  return {
    items,
    pagination: {
      total_records: 2,
      total_pages: 2,
      current_page: current,
      next_page: next,
      prev_page: current === 1 ? null : current - 1,
    },
  };
}

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "creem_migration_key" },
    requestId: parseId<"RequestId">("req_creemmig1", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
