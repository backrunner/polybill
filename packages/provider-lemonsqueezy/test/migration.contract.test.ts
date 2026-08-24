import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createLemonSqueezyAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_lemonmig1", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_lemonmig1", "conn"),
  tenantId,
  provider: "lemonSqueezy",
  environment: "test",
};

describe("Lemon Squeezy migration source", () => {
  it("rebuilds JSON:API pagination without following response links", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/customers?page%5Bnumber%5D=1&page%5Bsize%5D=100",
        response: Response.json(page([{ type: "customers", id: "1", attributes: {} }], 1, 2)),
      },
      {
        method: "GET",
        url: "https://api.lemonsqueezy.com/v1/customers?page%5Bnumber%5D=2&page%5Bsize%5D=100",
        response: Response.json(page([{ type: "customers", id: "2", attributes: {} }], 2, 2)),
      },
    ]);
    const source = createLemonSqueezyAdapter().migration;
    if (source === undefined) throw new Error("Lemon migration source is missing");

    const first = await source.scan(context(scripted.fetch), "customer");
    expect(first).toMatchObject({ items: [{ id: "1" }], nextCursor: "2" });
    await expect(
      source.scan(context(scripted.fetch), "customer", first.nextCursor),
    ).resolves.toEqual({ items: [{ type: "customers", id: "2", attributes: {} }] });
    await expect(source.scan(context(scripted.fetch), "payment_method")).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    scripted.assertConsumed();
  });
});

function page(items: readonly unknown[], currentPage: number, lastPage: number) {
  return {
    data: items,
    meta: { page: { currentPage, lastPage, perPage: 100, total: 2 } },
    links: { next: "https://evil.example/never-follow" },
  };
}

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "lemon_migration_key" },
    requestId: parseId<"RequestId">("req_lemonmig1", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
