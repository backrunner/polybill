import type { ProviderContext } from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import {
  verifyReceipt,
  verifySignedPaymentReceipt,
  type PaymentSettledNotify,
} from "x402-paysdk/merchant";
import { InjectedMerchantClient } from "./client.js";
import type { X402AdapterOptions } from "./config.js";

export interface ExpectedX402Settlement {
  readonly refId: string;
  readonly orderId: string;
  readonly atomicAmount: string;
}

export type X402SettlementResult =
  | {
      readonly status: "provisional";
      readonly reason: "receipt_missing" | "chain_pending";
      readonly txHash: string;
      readonly confirmations?: number;
    }
  | {
      readonly status: "confirmed";
      readonly txHash: string;
      readonly confirmations: number;
      readonly paymentId: string;
      readonly signer: string;
      readonly receiptHash: string;
    };

export async function verifyX402Settlement(
  context: ProviderContext,
  options: X402AdapterOptions,
  notify: PaymentSettledNotify,
  expected: ExpectedX402Settlement,
): Promise<X402SettlementResult> {
  assertNotifyTuple(context, options, notify, expected);
  if (notify.signedReceipt === undefined || notify.receipt === undefined)
    return { status: "provisional", reason: "receipt_missing", txHash: notify.txHash };

  const receipt = notify.receipt;
  assertReceiptTuple(context, options, notify, expected);
  let signed;
  try {
    signed = verifySignedPaymentReceipt({
      signedReceipt: notify.signedReceipt,
      receipt,
      trustedSigners: [...options.trustedReceiptSigners],
      expectedGateway: options.gateway,
      expectedPayTo: options.payTo,
      expectedAmount: expected.atomicAmount,
      ...(notify.paymentId === undefined ? {} : { expectedPaymentId: notify.paymentId }),
      expectedPayer: notify.payer,
    });
  } catch (cause) {
    throw invalidSettlement(context, cause);
  }
  const chain = await verifyReceipt(client(context, options), {
    signedReceipt: notify.signedReceipt,
    receipt,
    expectedPayTo: options.payTo,
    expectedAmount: expected.atomicAmount,
    minConfirmations: options.minConfirmations,
  });
  if (
    !chain.valid ||
    chain.txHash !== notify.txHash ||
    chain.network !== options.network ||
    chain.matches?.payTo !== true ||
    chain.matches.amount !== true ||
    chain.matches.payer !== true ||
    chain.matches.asset !== true
  )
    throw invalidSettlement(context);
  if (!chain.confirmed || (chain.confirmations ?? 0) < options.minConfirmations)
    return {
      status: "provisional",
      reason: "chain_pending",
      txHash: notify.txHash,
      ...(chain.confirmations === undefined ? {} : { confirmations: chain.confirmations }),
    };
  return {
    status: "confirmed",
    txHash: notify.txHash,
    confirmations: chain.confirmations ?? options.minConfirmations,
    paymentId: receipt.paymentId,
    signer: signed.signer,
    receiptHash: signed.contentHash,
  };
}

function assertNotifyTuple(
  context: ProviderContext,
  options: X402AdapterOptions,
  notify: PaymentSettledNotify,
  expected: ExpectedX402Settlement,
): void {
  if (
    notify.refId !== expected.refId ||
    (notify.invoiceId !== undefined && notify.invoiceId !== expected.orderId) ||
    notify.payTo.toLowerCase() !== options.payTo.toLowerCase() ||
    notify.network !== options.network ||
    notify.asset !== "USDC" ||
    notify.amount !== expected.atomicAmount
  )
    throw invalidSettlement(context);
}

function assertReceiptTuple(
  context: ProviderContext,
  options: X402AdapterOptions,
  notify: PaymentSettledNotify,
  expected: ExpectedX402Settlement,
): void {
  const receipt = notify.receipt;
  if (
    receipt === undefined ||
    receipt.refId !== expected.refId ||
    receipt.txHash !== notify.txHash ||
    receipt.payer.toLowerCase() !== notify.payer.toLowerCase() ||
    receipt.payTo.toLowerCase() !== options.payTo.toLowerCase() ||
    receipt.network !== options.network ||
    receipt.amount !== expected.atomicAmount ||
    receipt.assetSymbol !== "USDC" ||
    receipt.assetDecimals !== 6
  )
    throw invalidSettlement(context);
}

function client(context: ProviderContext, options: X402AdapterOptions): InjectedMerchantClient {
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined)
    throw new PolybillError("x402 merchant API key is missing", {
      code: "authentication_failed",
      operation: "x402.authenticate",
      provider: "x402",
      connectionId: context.connection.id,
      retryable: false,
    });
  return new InjectedMerchantClient(context, {
    gateway: options.gateway,
    apiKey,
    payTo: options.payTo,
    network: options.network,
    notifyNonceStore: options.nonceStore,
  });
}

function invalidSettlement(context: ProviderContext, cause?: unknown): PolybillError {
  return new PolybillError("x402 settlement evidence did not match the expected payment", {
    code: "provider_response_invalid",
    operation: "x402.settlement.verify",
    provider: "x402",
    connectionId: context.connection.id,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}
