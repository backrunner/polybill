import {
  canonicalWebhookEvent,
  object,
  optionalString,
  signatureError,
  stringField,
  verifyHmacHex,
  type WebhookProvider,
} from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";

const creditEvents = new Set([
  "credits.granted",
  "credits.consumed",
  "credits.reversed",
  "credits.auto_recharged",
  "customer_credits.exhausted",
]);

export const creemWebhooks: WebhookProvider = {
  async verify(input) {
    const signature = input.headers.get("creem-signature");
    if (signature === null) throw signatureError("creem");
    const active = await verifyHmacHex(input.secret.active, input.rawBody, signature);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await verifyHmacHex(input.secret.previous, input.rawBody, signature));
    if (!active && !previous) throw signatureError("creem");
    const root = decodeRoot(input.rawBody);
    const id = stringField(root, "id", "creem", "creem.webhook.decode");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "creem",
      environment: input.environment,
      deliveryKey: `creem:${id}`,
      providerEventId: id,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const payload = object(root.object, "creem", "creem.webhook.decode");
    const created = root.created_at;
    const type = stringField(root, "eventType", "creem", "creem.webhook.decode");
    const customer = creditEvents.has(type) ? optionalString(payload, "customer_id") : undefined;
    return {
      type,
      externalIds: {
        event: stringField(root, "id", "creem", "creem.webhook.decode"),
        object: stringField(payload, "id", "creem", "creem.webhook.decode"),
        ...(customer === undefined ? {} : { customer }),
      },
      ...(typeof created === "number"
        ? { occurredAt: parseIsoDateTime(new Date(created).toISOString()) }
        : {}),
      payload,
    };
  },
  async map(event, context) {
    const creditEvent = creditEvents.has(event.type);
    const mapping = mappingFor(event.type);
    const externalId = creditEvent ? event.externalIds.customer : event.externalIds.object;
    const name = creditEvent
      ? optionalString(object(event.payload, "creem", "creem.webhook.map"), "bucket_name")
          ?.trim()
          .toLowerCase()
      : undefined;
    if (mapping === undefined || externalId === undefined || (creditEvent && !name))
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
    const mapped = await canonicalWebhookEvent({
      event,
      context,
      type: id === undefined ? "unmapped_provider_event.v1" : mapping.type,
      aggregateType: id === undefined ? "connection" : mapping.aggregate,
      aggregateId: id ?? context.connection.id,
    });
    return [
      id !== undefined && name !== undefined ? { ...mapped, data: { walletName: name } } : mapped,
    ];
  },
};

function decodeRoot(raw: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw signatureError("creem");
  }
  return object(value, "creem", "creem.webhook.decode");
}

function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  if (creditEvents.has(type)) return { type: "credit_wallet.changed.v1", aggregate: "customer" };
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "checkout.completed": { type: "checkout.completed.v1", aggregate: "checkout" },
    "subscription.trialing": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.paused": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.update": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.scheduled_cancel": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.unpaid": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.expired": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.active": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.paid": { type: "payment.succeeded.v1", aggregate: "subscription" },
    "subscription.canceled": { type: "subscription.canceled.v1", aggregate: "subscription" },
    "subscription.past_due": { type: "subscription.past_due.v1", aggregate: "subscription" },
    "refund.created": { type: "refund.created.v1", aggregate: "refund" },
  };
  return map[type];
}
