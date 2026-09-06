import { canonicalWebhookEvent, signatureError, type WebhookProvider } from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import { verifySettlementNotify, type SettlementNotify } from "x402-paysdk/merchant";
import type { X402AdapterOptions } from "./config.js";

export function createX402Webhooks(options: X402AdapterOptions): WebhookProvider {
  return {
    async verify(input) {
      const keys: Record<string, string> = {
        [input.secret.activeKeyId]: input.secret.active,
      };
      if (input.secret.previous !== undefined && input.secret.previousKeyId !== undefined)
        keys[input.secret.previousKeyId] = input.secret.previous;
      const result = await verifySettlementNotify(
        input.headers,
        input.rawBody,
        keys,
        input.replayProtection === "inbox" ? { putIfAbsent: () => true } : options.nonceStore,
        Math.floor(Date.parse(input.now) / 1000),
        options.notifyToleranceSeconds,
        options.notifyMaxBodyBytes,
      );
      if (!result.ok) throw verificationError(result.reason);
      if (
        options.expectedMerchantId !== undefined &&
        result.notify.merchantId !== options.expectedMerchantId
      )
        throw signatureError("x402");
      const providerEventId = `${result.notify.event}:${result.notify.merchantId}:${result.notify.refId}:${result.notify.nonce}`;
      return {
        provider: "x402",
        environment: input.environment,
        deliveryKey: `x402:${result.keyId}:${result.notify.nonce}`,
        providerEventId,
        rawBody: input.rawBody,
        verifiedAt: input.now,
        keyId: result.keyId,
      };
    },
    decode(event) {
      const notify = decodeVerifiedNotify(event.rawBody);
      return {
        type: notify.event,
        externalIds: {
          ...(event.providerEventId === undefined ? {} : { event: event.providerEventId }),
          ref: notify.refId,
          ...(notify.paymentId === undefined ? {} : { payment: notify.paymentId }),
          ...(notify.invoiceId === undefined ? {} : { order: notify.invoiceId }),
          ...(notify.event === "payment.settled" ? { transaction: notify.txHash } : {}),
        },
        occurredAt: parseIsoDateTime(new Date(notify.timestamp * 1000).toISOString()),
        payload: notify,
      };
    },
    async map(event, context) {
      const externalId = event.externalIds.payment ?? event.externalIds.ref;
      const entityType = event.type === "refund.settled" ? "refund" : "payment";
      const id =
        externalId === undefined
          ? undefined
          : await context.lookup.findCanonicalId({
              tenantId: context.tenantId,
              connectionId: context.connection.id,
              entityType,
              externalId,
            });
      return [
        await canonicalWebhookEvent({
          event,
          context,
          type:
            id === undefined
              ? "unmapped_provider_event.v1"
              : event.type === "payment.settled"
                ? "payment.settlement_observed.v1"
                : "refund.settlement_observed.v1",
          aggregateType: id === undefined ? "connection" : entityType,
          aggregateId: id ?? context.connection.id,
        }),
      ];
    },
  };
}

function decodeVerifiedNotify(rawBody: Uint8Array): SettlementNotify {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    ) as SettlementNotify;
  } catch {
    throw signatureError("x402");
  }
}

function verificationError(reason: string): PolybillError {
  if (reason === "replayed_nonce" || reason === "timestamp_out_of_window")
    return new PolybillError("x402 notification replay was rejected", {
      code: "replay_rejected",
      operation: "webhook.verify",
      provider: "x402",
      retryable: false,
    });
  return signatureError("x402");
}
