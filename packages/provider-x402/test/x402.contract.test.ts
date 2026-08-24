import { createWebCryptoPort } from "@polybill/adapter-kit";
import {
  money,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type ConnectionRef,
} from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import type { NotifyNonceStore, PaymentReceipt, PaymentSettledNotify } from "x402-paysdk/merchant";
import { describe, expect, it } from "vitest";
import { createX402Adapter, verifyX402Settlement, type X402AdapterOptions } from "../src/index.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SIGNER = "0x4a62316623ad457f02cdc5d997ded67a383ec569";
const TX_HASH = `0x${"aa".repeat(32)}`;
const NOW_SECONDS = 1_800_000_000;
const SIGNED_RECEIPT =
  "eyJhbGciOiJFSVAxOTEtU0VDUDI1NksxIiwia2lkIjoia2lkLXRlc3QiLCJzaWduZXIiOiIweDRhNjIzMTY2MjNhZDQ1N2YwMmNkYzVkOTk3ZGVkNjdhMzgzZWM1NjkiLCJjb250ZW50SGFzaCI6InNoYTI1NjozMjVhZjBiNzYwNzYwYTQwZTlhMzk2MDMzNDlkOWI3YmZlZjU4MmY5MTJkYzQzNTcwNWU1ZTNiMDY0NzdjZTk0Iiwic2lnbmF0dXJlIjoiMHgzZWExM2YwODY1MzA0OGY3NjM0ZWIwZTc2OWYzNDBjYjUzYzRhMDc0ZGRiYmNhMzYyMDE0NDg4M2ZhNjk2N2EwMTQ5ODJmMzdmYjNiY2ZiM2FhNWUzMzViZjZjMmRhZWYwOTA0YmIwZDE5YmY5ZTRkMWI2N2JmMWZmNTI5OWZiNDFiIn0";

const tenantId = parseId<"TenantId">("ten_x4020001", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_x4020001", "conn"),
  tenantId,
  provider: "x402",
  environment: "test",
};

describe("x402 adapter contract", () => {
  it("creates a fixed USDC payment ref from canonical minor units", async () => {
    const scripted = createScriptedFetch([
      {
        method: "POST",
        url: "https://pay.example/ref",
        response: Response.json({
          refId: "ref_test",
          refUrl: "x402pay://ref_test",
          snapshot: {
            v: 2,
            scheme: "exact",
            network: "eip155:8453",
            payTo: PAY_TO,
            asset: "USDC",
            amount: "25000000",
            resource: "https://pay.example/ref/ref_test",
            mimeType: "application/json",
          },
        }),
      },
    ]);
    const adapter = createX402Adapter(options(createNonceStore()));
    const result = await adapter.checkout?.create(context(scripted.fetch), {
      orderId: parseId<"OrderId">("ord_x4020001", "ord"),
      lines: [
        {
          skuId: parseId<"SkuId">("sku_x4020001", "sku"),
          quantity: 1,
          price: { kind: "one_time", unit: money("2500", "USD") },
          unitAmount: money("2500", "USD"),
        },
      ],
      grossTotal: money("2500", "USD"),
      total: money("2500", "USD"),
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
      metadata: {},
    });
    expect(result?.value.url).toBe("x402pay://ref_test");
    expect(await scripted.requests[0]?.clone().json()).toMatchObject({
      amount: "25000000",
      invoiceId: "ord_x4020001",
    });
    scripted.assertConsumed();
  });

  it("verifies notify HMAC and emits only a provisional synchronization event", async () => {
    const nonceStore = createNonceStore();
    const adapter = createX402Adapter(options(nonceStore));
    const nonce = "a".repeat(32);
    const body = JSON.stringify({
      event: "payment.settled",
      refId: "ref_test",
      merchantId: "mer_test",
      paymentId: "pay_test",
      invoiceId: "ord_x4020001",
      txHash: TX_HASH,
      payer: PAYER,
      payTo: PAY_TO,
      amount: "10000",
      asset: "USDC",
      network: "eip155:8453",
      timestamp: NOW_SECONDS,
      nonce,
    });
    const headers = await notifyHeaders(body, nonce);
    const input = {
      rawBody: new TextEncoder().encode(body),
      headers,
      secret: { active: "notify-secret", activeKeyId: "kid-test" },
      environment: "test" as const,
      now: parseIsoDateTime(new Date(NOW_SECONDS * 1000).toISOString()),
    };
    const verified = await adapter.webhooks.verify(input);
    const decoded = adapter.webhooks.decode(verified);
    const events = await adapter.webhooks.map(decoded, {
      tenantId,
      connection,
      observedAt: input.now,
      lookup: { findCanonicalId: async () => "pay_canonical" },
    });
    expect(events[0]?.type).toBe("payment.settlement_observed.v1");
    expect(events[0]?.type).not.toBe("payment.succeeded.v1");
    await expect(adapter.webhooks.verify(input)).rejects.toMatchObject({
      code: "replay_rejected",
    });
  });

  it("requires signed receipt and sufficient chain confirmations", async () => {
    const confirmed = createScriptedFetch([
      {
        method: "POST",
        url: "https://pay.example/verify-receipt",
        response: Response.json(chainResult(true, 3)),
      },
    ]);
    const result = await verifyX402Settlement(
      context(confirmed.fetch),
      options(createNonceStore()),
      settledNotify(),
      { refId: "ref_test", orderId: "ord_x4020001", atomicAmount: "10000" },
    );
    expect(result).toMatchObject({
      status: "confirmed",
      txHash: TX_HASH,
      confirmations: 3,
      signer: SIGNER,
    });

    const pending = createScriptedFetch([
      {
        method: "POST",
        url: "https://pay.example/verify-receipt",
        response: Response.json(chainResult(false, 1)),
      },
    ]);
    await expect(
      verifyX402Settlement(context(pending.fetch), options(createNonceStore()), settledNotify(), {
        refId: "ref_test",
        orderId: "ord_x4020001",
        atomicAmount: "10000",
      }),
    ).resolves.toMatchObject({ status: "provisional", reason: "chain_pending" });
  });

  it("rejects a settlement tuple mismatch before chain access", async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error("chain access must not occur");
    };
    await expect(
      verifyX402Settlement(
        context(fetch),
        options(createNonceStore()),
        settledNotify({ amount: "9999" }),
        { refId: "ref_test", orderId: "ord_x4020001", atomicAmount: "10000" },
      ),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
});

function options(nonceStore: NotifyNonceStore): X402AdapterOptions {
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
    trustedReceiptSigners: [SIGNER],
    minConfirmations: 2,
    nonceStore,
  };
}

function context(fetch: typeof globalThis.fetch) {
  return {
    tenantId,
    connection,
    credentials: { apiKey: "x402_test_key" },
    requestId: parseId<"RequestId">("req_x4020001", "req"),
    idempotencyKey: parseIdempotencyKey("x402-checkout-0001"),
    deadline: parseIsoDateTime("2027-01-15T08:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2027-01-15T08:00:00.000Z"),
  } as const;
}

function createNonceStore(): NotifyNonceStore {
  const values = new Set<string>();
  return {
    putIfAbsent(key) {
      if (values.has(key)) return false;
      values.add(key);
      return true;
    },
  };
}

function receipt(): PaymentReceipt {
  return {
    type: "x402.payment.receipt",
    version: 1,
    gatewayOrigin: "https://pay.example",
    resourceUrl: `https://pay.example/receive/${PAY_TO}?ref=ref_test`,
    refId: "ref_test",
    paymentId: "pay_test",
    scheme: "exact",
    payer: PAYER,
    payTo: PAY_TO,
    network: "eip155:8453",
    chainId: 8453,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetSymbol: "USDC",
    assetDecimals: 6,
    amount: "10000",
    issuedAt: 1_767_225_600,
    txHash: TX_HASH,
    settlementStatus: "submitted",
  };
}

function settledNotify(overrides: Partial<PaymentSettledNotify> = {}): PaymentSettledNotify {
  return {
    event: "payment.settled",
    refId: "ref_test",
    merchantId: "mer_test",
    invoiceId: "ord_x4020001",
    paymentId: "pay_test",
    payer: PAYER,
    payTo: PAY_TO,
    amount: "10000",
    asset: "USDC",
    network: "eip155:8453",
    timestamp: NOW_SECONDS,
    nonce: "b".repeat(32),
    txHash: TX_HASH,
    signedReceipt: SIGNED_RECEIPT,
    receipt: receipt(),
    ...overrides,
  };
}

function chainResult(confirmed: boolean, confirmations: number) {
  return {
    valid: true,
    confirmed,
    txHash: TX_HASH,
    payer: PAYER,
    payTo: PAY_TO,
    network: "eip155:8453",
    amount: "10000",
    confirmations,
    matches: { payTo: true, amount: true, payer: true, asset: true },
  };
}

async function notifyHeaders(body: string, nonce: string): Promise<Headers> {
  const bodyHash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const digest = Array.from(new Uint8Array(bodyHash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const canonical = `payment.settled|${NOW_SECONDS}|${nonce}|mer_test|ref_test|${digest}`;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("notify-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
  );
  return new Headers({
    "x-402-signature": Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    "x-402-key-id": "kid-test",
    "x-402-event": "payment.settled",
    "x-402-timestamp": String(NOW_SECONDS),
    "x-402-nonce": nonce,
    "x-402-merchant-id": "mer_test",
    "x-402-ref-id": "ref_test",
  });
}
