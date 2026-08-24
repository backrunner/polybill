import {
  assertWebhookTimestamp,
  canonicalWebhookEvent,
  joinBytes,
  object,
  optionalString,
  signatureError,
  stringField,
  utf8,
  verifyHmacHex,
  type WebhookProvider,
} from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";

export const paddleWebhooks: WebhookProvider = {
  async verify(input) {
    const header = input.headers.get("paddle-signature");
    if (header === null) throw signatureError("paddle");
    const parts = header.split(";").map((part) => part.trim());
    const timestampText = parts.find((part) => part.startsWith("ts="))?.slice(3);
    const signatures = parts.filter((part) => part.startsWith("h1=")).map((part) => part.slice(3));
    const timestamp = Number(timestampText);
    assertWebhookTimestamp(timestamp, input.now, 300, "paddle");
    const message = joinBytes(utf8(`${timestamp}:`), input.rawBody);
    const active = await matches(input.secret.active, signatures, message);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await matches(input.secret.previous, signatures, message));
    if (!active && !previous) throw signatureError("paddle");
    const root = decodeRoot(input.rawBody);
    const id = stringField(root, "event_id", "paddle", "paddle.webhook.decode");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "paddle",
      environment: input.environment,
      deliveryKey: `paddle:${id}`,
      providerEventId: id,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const payload = object(root.data, "paddle", "paddle.webhook.decode");
    const occurredAt = optionalString(root, "occurred_at");
    return {
      type: stringField(root, "event_type", "paddle", "paddle.webhook.decode"),
      externalIds: {
        event: stringField(root, "event_id", "paddle", "paddle.webhook.decode"),
        object: stringField(payload, "id", "paddle", "paddle.webhook.decode"),
      },
      ...(occurredAt === undefined ? {} : { occurredAt: parseIsoDateTime(occurredAt) }),
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

async function matches(
  secret: string,
  signatures: readonly string[],
  message: Uint8Array,
): Promise<boolean> {
  for (const signature of signatures)
    if (await verifyHmacHex(secret, message, signature)) return true;
  return false;
}
function decodeRoot(raw: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw signatureError("paddle");
  }
  return object(value, "paddle", "paddle.webhook.decode");
}
function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "transaction.completed": { type: "payment.succeeded.v1", aggregate: "order" },
    "transaction.payment_failed": { type: "payment.failed.v1", aggregate: "order" },
    "subscription.created": { type: "subscription.created.v1", aggregate: "subscription" },
    "subscription.updated": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.canceled": { type: "subscription.canceled.v1", aggregate: "subscription" },
    "adjustment.updated": { type: "refund.changed.v1", aggregate: "refund" },
  };
  return map[type];
}
