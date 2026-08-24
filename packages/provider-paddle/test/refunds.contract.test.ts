import { createWebCryptoPort } from "@polybill/adapter-kit";
import { money, parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createPaddleAdapter } from "../src/index.js";

describe("Paddle refund contract", () => {
  it("allocates canonical partial amounts across authoritative transaction lines", async () => {
    const transaction = {
      id: "txn_fixture",
      currency_code: "USD",
      details: {
        line_items: [
          { id: "txnitm_one", totals: { total: "700" } },
          { id: "txnitm_two", totals: { total: "500" } },
        ],
      },
    };
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/transactions/txn_fixture",
        response: Response.json({ data: transaction }),
      },
      {
        method: "POST",
        url: "https://sandbox-api.paddle.com/adjustments",
        response: Response.json({
          data: adjustment("adj_partial", "pending_approval", "900"),
        }),
      },
      {
        method: "POST",
        url: "https://sandbox-api.paddle.com/adjustments",
        response: Response.json({ data: adjustment("adj_full", "approved", "1200") }),
      },
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/adjustments/adj_full",
        response: Response.json({ data: adjustment("adj_full", "approved", "1200") }),
      },
    ]);
    const refunds = createPaddleAdapter().refunds;
    if (refunds?.create === undefined || refunds.get === undefined)
      throw new Error("Paddle refund port is missing");

    await expect(
      refunds.create(context(scripted.fetch), {
        externalPaymentId: "txn_fixture",
        amount: money("900", "USD"),
        reason: "requested_by_customer",
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { amount: money("900", "USD"), status: "pending" } });
    await expect(scripted.requests[1]?.clone().json()).resolves.toMatchObject({
      type: "partial",
      items: [
        { item_id: "txnitm_one", type: "partial", amount: "700" },
        { item_id: "txnitm_two", type: "partial", amount: "200" },
      ],
    });
    await expect(
      refunds.create(context(scripted.fetch), {
        externalPaymentId: "txn_fixture",
        metadata: {},
      }),
    ).resolves.toMatchObject({ value: { status: "succeeded" } });
    await expect(refunds.get(context(scripted.fetch), "adj_full")).resolves.toMatchObject({
      value: { externalId: "adj_full", status: "succeeded" },
    });
    scripted.assertConsumed();
  });

  it("rejects currency mismatch before creating an adjustment", async () => {
    const scripted = createScriptedFetch([
      {
        method: "GET",
        url: "https://sandbox-api.paddle.com/transactions/txn_fixture",
        response: Response.json({
          data: {
            id: "txn_fixture",
            currency_code: "EUR",
            details: { line_items: [{ id: "txnitm_one", totals: { total: "700" } }] },
          },
        }),
      },
    ]);
    await expect(
      createPaddleAdapter().refunds?.create?.(context(scripted.fetch), {
        externalPaymentId: "txn_fixture",
        amount: money("100", "USD"),
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    scripted.assertConsumed();
  });
});

function adjustment(id: string, status: string, total: string) {
  return {
    id,
    transaction_id: "txn_fixture",
    currency_code: "USD",
    status,
    totals: { total },
  };
}

function context(fetch: typeof globalThis.fetch) {
  const tenantId = parseId<"TenantId">("ten_paddlerefund", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_paddlerefund", "conn"),
      tenantId,
      provider: "paddle" as const,
      environment: "test" as const,
    },
    credentials: { apiKey: "pdl_sdbx_fixture" },
    requestId: parseId<"RequestId">("req_paddlerefund", "req"),
    idempotencyKey: parseIdempotencyKey("paddle-refund-fixture"),
    deadline: parseIsoDateTime("2026-08-25T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
  } as const;
}
