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

export const stripeWebhooks: WebhookProvider = {
  async verify(input) {
    const header = input.headers.get("stripe-signature");
    if (header === null) throw signatureError("stripe");
    const fields = header.split(",").map((part) => part.trim());
    const timestampText = fields.find((part) => part.startsWith("t="))?.slice(2);
    const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
    const timestamp = Number(timestampText);
    assertWebhookTimestamp(timestamp, input.now, 300, "stripe");
    const message = joinBytes(utf8(`${timestamp}.`), input.rawBody);
    const active = await matches(input.secret.active, signatures, message);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await matches(input.secret.previous, signatures, message));
    if (!active && !previous) throw signatureError("stripe");
    const root = decodeRoot(input.rawBody);
    const eventId = stringField(root, "id", "stripe", "stripe.webhook.decode");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "stripe",
      environment: input.environment,
      deliveryKey: `stripe:${eventId}`,
      providerEventId: eventId,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const data = object(root.data, "stripe", "stripe.webhook.decode");
    const payload = object(data.object, "stripe", "stripe.webhook.decode");
    const paymentIntent = optionalString(payload, "payment_intent");
    const created = root.created;
    return {
      type: stringField(root, "type", "stripe", "stripe.webhook.decode"),
      externalIds: {
        event: stringField(root, "id", "stripe", "stripe.webhook.decode"),
        object: stringField(payload, "id", "stripe", "stripe.webhook.decode"),
        ...(paymentIntent === undefined ? {} : { payment: paymentIntent }),
      },
      ...(typeof created === "number"
        ? { occurredAt: parseIsoDateTime(new Date(created * 1000).toISOString()) }
        : {}),
      payload,
    };
  },
  async map(event, context) {
    const mapping = eventMapping(event.type);
    if (mapping === undefined)
      return [
        await canonicalWebhookEvent({
          event,
          context,
          type: "unmapped_provider_event.v1",
          aggregateType: "connection",
          aggregateId: context.connection.id,
        }),
      ];
    const externalId =
      mapping.aggregate === "payment"
        ? (event.externalIds.payment ?? event.externalIds.object)
        : event.externalIds.object;
    if (externalId === undefined)
      return [
        await canonicalWebhookEvent({
          event,
          context,
          type: "unmapped_provider_event.v1",
          aggregateType: "connection",
          aggregateId: context.connection.id,
        }),
      ];
    const canonicalId = await context.lookup.findCanonicalId({
      tenantId: context.tenantId,
      connectionId: context.connection.id,
      entityType: mapping.aggregate,
      externalId,
    });
    return [
      await canonicalWebhookEvent({
        event,
        context,
        type: canonicalId === undefined ? "unmapped_provider_event.v1" : mapping.type,
        aggregateType: canonicalId === undefined ? "connection" : mapping.aggregate,
        aggregateId: canonicalId ?? context.connection.id,
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

function decodeRoot(rawBody: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw signatureError("stripe");
  }
  return object(value, "stripe", "stripe.webhook.decode");
}

function eventMapping(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const values: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "checkout.session.completed": { type: "checkout.completed.v1", aggregate: "checkout" },
    "checkout.session.expired": { type: "checkout.expired.v1", aggregate: "checkout" },
    "payment_intent.succeeded": { type: "payment.succeeded.v1", aggregate: "payment" },
    "payment_intent.payment_failed": { type: "payment.failed.v1", aggregate: "payment" },
    "payment_intent.processing": { type: "payment.processing.v1", aggregate: "payment" },
    "payment_intent.requires_action": {
      type: "payment.action_required.v1",
      aggregate: "payment",
    },
    "payment_intent.canceled": { type: "payment.canceled.v1", aggregate: "payment" },
    "customer.subscription.created": { type: "subscription.created.v1", aggregate: "subscription" },
    "customer.subscription.updated": { type: "subscription.changed.v1", aggregate: "subscription" },
    "customer.subscription.deleted": {
      type: "subscription.canceled.v1",
      aggregate: "subscription",
    },
    "refund.updated": { type: "refund.changed.v1", aggregate: "refund" },
  };
  return values[type];
}
