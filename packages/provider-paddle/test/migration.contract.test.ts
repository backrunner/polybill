import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPaddleAdapter } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_paddlemig1", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_paddlemig1", "conn"),
  tenantId,
  provider: "paddle",
  environment: "test",
};

describe("Paddle migration source", () => {
  it("extracts a cursor only from a trusted next URL", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/products?per_page=100",
        response: page(
          [{ id: "pro_1" }],
          true,
          "https://sandbox-api.paddle.com/products?after=pro_1&per_page=100",
        ),
      },
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/products?per_page=100&after=pro_1",
        response: page([{ id: "pro_2" }], false, ""),
      },
    ]);
    const source = createPaddleAdapter().migration;
    if (source === undefined) throw new Error("Paddle migration source is missing");
    const first = await source.scan(context(scripted.fetch), "product");
    expect(first).toMatchObject({ items: [{ id: "pro_1" }], nextCursor: "pro_1" });
    await expect(
      source.scan(context(scripted.fetch), "product", first.nextCursor),
    ).resolves.toEqual({
      items: [{ id: "pro_2" }],
    });
    scripted.assertConsumed();
  });

  it("rejects an untrusted provider next URL instead of following it", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/products?per_page=100",
        response: page([{ id: "pro_1" }], true, "https://evil.example/products?after=stolen"),
      },
    ]);
    const source = createPaddleAdapter().migration;
    if (source === undefined) throw new Error("Paddle migration source is missing");
    await expect(source.scan(context(scripted.fetch), "product")).rejects.toMatchObject({
      code: "invalid_request",
    });
    scripted.assertConsumed();
  });
});

function page(items: readonly unknown[], hasMore: boolean, next: string): Response {
  return Response.json({
    data: items,
    meta: { pagination: { per_page: 100, next, has_more: hasMore, estimated_total: items.length } },
  });
}

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "pdl_sdbx_migration_key" },
    requestId: parseId<"RequestId">("req_paddlemig1", "req"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
