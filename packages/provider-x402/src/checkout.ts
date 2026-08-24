import type {
  CheckoutProvider,
  ProviderCheckoutSnapshot,
  ProviderContext,
  ProviderOperationResult,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import { createPaymentRef, getRef } from "x402-paysdk/merchant";
import { InjectedMerchantClient } from "./client.js";
import type { X402AdapterOptions } from "./config.js";

export function createX402Checkout(options: X402AdapterOptions): CheckoutProvider {
  return {
    async create(context, command) {
      if (command.total.currency !== options.settlement.pricingCurrency)
        throw unsupported(
          context,
          "x402 fixed settlement only accepts the configured pricing currency",
        );
      const amount = (
        BigInt(command.total.amount) * BigInt(options.settlement.atomicPerMinor)
      ).toString();
      const ref = await createPaymentRef(client(context, options), {
        payTo: options.payTo,
        network: options.network,
        asset: "USDC",
        amount,
        invoiceId: command.orderId,
        ...(options.notifyUrl === undefined ? {} : { notifyUrl: options.notifyUrl }),
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expiresInSecs: options.expiresInSeconds }),
        label: `Polybill order ${command.orderId}`,
      });
      const value: ProviderCheckoutSnapshot = {
        externalId: ref.refId,
        status: "open",
        url: ref.refUrl,
        ...(ref.snapshot.expiresAt === undefined
          ? {}
          : { expiresAt: parseIsoDateTime(new Date(ref.snapshot.expiresAt * 1000).toISOString()) }),
        rawStatus: "active",
      };
      return result(context, value);
    },
    async get(context, externalId) {
      const ref = await getRef(client(context, options), externalId);
      const value: ProviderCheckoutSnapshot = {
        externalId,
        status: "open",
        url: ref.resource,
        ...(ref.expiresAt === undefined
          ? {}
          : { expiresAt: parseIsoDateTime(new Date(ref.expiresAt * 1000).toISOString()) }),
        rawStatus: "active",
      };
      return result(context, value);
    },
  };
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

function result(
  context: ProviderContext,
  value: ProviderCheckoutSnapshot,
): ProviderOperationResult<ProviderCheckoutSnapshot> {
  return {
    value,
    evidence: {
      provider: "x402",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "both",
    warnings: [
      {
        code: "manual_reauthorization",
        message: "x402 settlement requires a payer authorization for every payment",
      },
    ],
  };
}

function unsupported(context: ProviderContext, message: string): PolybillError {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "x402.checkout.create",
    provider: "x402",
    connectionId: context.connection.id,
    retryable: false,
  });
}
