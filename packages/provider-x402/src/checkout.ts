import type {
  CheckoutProvider,
  ProviderCheckoutSnapshot,
  ProviderContext,
  ProviderOperationResult,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import { createPaymentRef, getRef, listRefs } from "x402-paysdk/merchant";
import { InjectedMerchantClient } from "./client.js";
import type { X402AdapterOptions } from "./config.js";
import { decodePaymentRef, decodePaymentRefSnapshot, decodeRefList } from "./refs-codec.js";

export function createX402Checkout(options: X402AdapterOptions): CheckoutProvider {
  return {
    async create(context, command) {
      if (command.total.currency !== options.settlement.pricingCurrency)
        throw unsupported(
          context,
          "x402 fixed settlement only accepts the configured pricing currency",
        );
      const amount = toAtomicAmount(command.total.amount, options.settlement.atomicPerMinor);
      const ref = decodePaymentRef(
        await createPaymentRef(client(context, options), {
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
        }),
      );
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
      const ref = decodePaymentRefSnapshot(await getRef(client(context, options), externalId));
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
    async recoverByIdempotencyKey(context, _key, command) {
      const amount = toAtomicAmount(command.total.amount, options.settlement.atomicPerMinor);
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let page = 0; page < 100; page += 1) {
        const refs = decodeRefList(
          await listRefs(client(context, options), {
            payTo: options.payTo,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        const match = refs.items.find(
          (item) =>
            item.invoiceId === command.orderId &&
            item.network === options.network &&
            item.payTo.toLowerCase() === options.payTo.toLowerCase() &&
            item.asset === "USDC" &&
            item.amount === amount,
        );
        if (match !== undefined) {
          const snapshot = decodePaymentRefSnapshot(
            await getRef(client(context, options), match.refId),
          );
          if (
            snapshot.network !== options.network ||
            snapshot.payTo.toLowerCase() !== options.payTo.toLowerCase() ||
            snapshot.asset !== "USDC" ||
            snapshot.amount !== amount ||
            snapshot.invoiceId !== command.orderId
          )
            throw new TypeError("x402 recovered ref did not match the requested order");
          return result(context, {
            externalId: match.refId,
            status: match.status === "revoked" ? "canceled" : "open",
            url: snapshot.resource,
            ...(match.expiresAt === undefined
              ? {}
              : { expiresAt: parseIsoDateTime(new Date(match.expiresAt * 1000).toISOString()) }),
            total: command.total,
            rawStatus: match.status,
          });
        }
        if (refs.nextCursor === undefined) return undefined;
        if (seenCursors.has(refs.nextCursor)) throw new TypeError("x402 ref cursor repeated");
        seenCursors.add(refs.nextCursor);
        cursor = refs.nextCursor;
      }
      throw new TypeError("x402 ref recovery exceeded the page limit");
    },
  };
}

function toAtomicAmount(amount: string, atomicPerMinor: string): string {
  return (BigInt(amount) * BigInt(atomicPerMinor)).toString();
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
