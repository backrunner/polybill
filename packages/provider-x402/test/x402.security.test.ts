import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId, parseIdempotencyKey, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { VirtualClock } from "@polybill/testing";
import type { NotifyNonceStore, PaymentSettledNotify } from "x402-paysdk/merchant";
import { describe, expect, it } from "vitest";
import { verifyX402Settlement, type X402AdapterOptions } from "../src/index.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"aa".repeat(32)}`;
const tenantId = parseId<"TenantId">("ten_x402sec01", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_x402sec01", "conn"),
  tenantId,
  provider: "x402",
  environment: "test",
};

describe("x402 settlement security", () => {
  it("rejects every expected tuple mismatch before chain access", async () => {
    let fetchCalls = 0;
    const fetch = async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("chain access must not occur");
    };
    const cases: readonly Partial<PaymentSettledNotify>[] = [
      { amount: "9999" },
      { network: "eip155:1" },
      { payTo: "0x3333333333333333333333333333333333333333" },
      { refId: "ref_other" },
      { invoiceId: "ord_other" },
    ];

    for (const overrides of cases) {
      await expect(
        verifyX402Settlement(context(fetch), options(), notify(overrides), {
          refId: "ref_test",
          orderId: "ord_x402sec01",
          atomicAmount: "10000",
        }),
      ).rejects.toMatchObject({
        code: "provider_response_invalid",
        operation: "x402.settlement.verify",
      });
    }
    expect(fetchCalls).toBe(0);
  });
});

function notify(overrides: Partial<PaymentSettledNotify>): PaymentSettledNotify {
  return {
    event: "payment.settled",
    refId: "ref_test",
    merchantId: "mer_test",
    invoiceId: "ord_x402sec01",
    paymentId: "pay_test",
    payer: PAYER,
    payTo: PAY_TO,
    amount: "10000",
    asset: "USDC",
    network: "eip155:8453",
    timestamp: 1_800_000_000,
    nonce: "b".repeat(32),
    txHash: TX_HASH,
    ...overrides,
  };
}

function options(): X402AdapterOptions {
  const nonceStore: NotifyNonceStore = { putIfAbsent: () => true };
  return {
    gateway: "https://pay.example",
    payTo: PAY_TO,
    network: "eip155:8453",
    expectedMerchantId: "mer_test",
    settlement: {
      kind: "fixed",
      pricingCurrency: "USD",
      atomicPerMinor: "10000",
      acceptPegRisk: true,
    },
    trustedReceiptSigners: ["0x4a62316623ad457f02cdc5d997ded67a383ec569"],
    minConfirmations: 2,
    nonceStore,
  };
}

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "x402_test_key" },
    requestId: parseId<"RequestId">("req_x402sec01", "req"),
    idempotencyKey: parseIdempotencyKey("x402-security-0001"),
    deadline: parseIsoDateTime("2027-01-15T08:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2027-01-15T08:00:00.000Z"),
  } as const;
}
