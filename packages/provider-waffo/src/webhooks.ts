import {
  canonicalWebhookEvent,
  joinBytes,
  object,
  optionalString,
  signatureError,
  stringField,
  utf8,
  verifyRsaSha256,
  type WebhookProvider,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";

export const waffoWebhooks: WebhookProvider = {
  async verify(input) {
    const header = input.headers.get("x-waffo-signature");
    if (header === null) throw signatureError("waffo");
    const parts = header.split(",").map((part) => part.trim());
    const timestampText = parts.find((part) => part.startsWith("t="))?.slice(2);
    const signature = parts.find((part) => part.startsWith("v1="))?.slice(3);
    if (timestampText === undefined || signature === undefined) throw signatureError("waffo");
    const timestamp = Number(timestampText);
    const age = Date.parse(input.now) - timestamp;
    if (!Number.isSafeInteger(timestamp) || age > 45 * 60 * 1000 || age < -60 * 1000)
      throw new PolybillError("Waffo webhook timestamp is outside the accepted tolerance", {
        code: "replay_rejected",
        operation: "webhook.verify",
        provider: "waffo",
        retryable: false,
      });
    const message = joinBytes(utf8(`${timestampText}.`), input.rawBody);
    const active = await verifyRsaSha256(input.secret.active, message, signature);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await verifyRsaSha256(input.secret.previous, message, signature));
    if (!active && !previous) throw signatureError("waffo");
    const root = decodeRoot(input.rawBody);
    const mode = stringField(root, "mode", "waffo", "waffo.webhook.decode");
    if (mode !== (input.environment === "test" ? "test" : "prod")) throw signatureError("waffo");
    const headerEnvironment = input.headers.get("x-environment");
    if (headerEnvironment !== null && headerEnvironment !== mode) throw signatureError("waffo");
    const id = stringField(root, "id", "waffo", "waffo.webhook.decode");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "waffo",
      environment: input.environment,
      deliveryKey: `waffo:${id}`,
      providerEventId: id,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const payload = object(root.data, "waffo", "waffo.webhook.decode");
    return {
      type: stringField(root, "eventType", "waffo", "waffo.webhook.decode"),
      externalIds: {
        event: stringField(root, "id", "waffo", "waffo.webhook.decode"),
        object: stringField(root, "eventId", "waffo", "waffo.webhook.decode"),
        ...(optionalString(payload, "orderId") === undefined
          ? {}
          : { order: optionalString(payload, "orderId") ?? "" }),
      },
      occurredAt: parseIsoDateTime(stringField(root, "timestamp", "waffo", "waffo.webhook.decode")),
      payload,
    };
  },
  async map(event, context) {
    const mapping = mappingFor(event.type);
    const externalId = event.externalIds.object;
    if (mapping === undefined || externalId === undefined)
      return [
        await canonicalWebhookEvent({
          event,
          context,
          type: "unmapped_provider_event.v1",
          aggregateType: "connection",
          aggregateId: context.connection.id,
        }),
      ];
    const id = await context.lookup.findCanonicalId({
      tenantId: context.tenantId,
      connectionId: context.connection.id,
      entityType: mapping.aggregate,
      externalId,
    });
    return [
      await canonicalWebhookEvent({
        event,
        context,
        type: id === undefined ? "unmapped_provider_event.v1" : mapping.type,
        aggregateType: id === undefined ? "connection" : mapping.aggregate,
        aggregateId: id ?? context.connection.id,
      }),
    ];
  },
};

function decodeRoot(raw: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw signatureError("waffo");
  }
  return object(value, "waffo", "waffo.webhook.decode");
}
function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "order.completed": { type: "payment.succeeded.v1", aggregate: "payment" },
    "subscription.activated": { type: "subscription.created.v1", aggregate: "subscription" },
    "subscription.payment_succeeded": { type: "payment.succeeded.v1", aggregate: "payment" },
    "subscription.canceling": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.canceled": { type: "subscription.canceled.v1", aggregate: "subscription" },
    "subscription.past_due": { type: "subscription.past_due.v1", aggregate: "subscription" },
    "refund.succeeded": { type: "refund.succeeded.v1", aggregate: "refund" },
    "refund.failed": { type: "refund.failed.v1", aggregate: "refund" },
  };
  return map[type];
}
