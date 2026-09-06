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

export const lemonWebhooks: WebhookProvider = {
  async verify(input) {
    const signature = input.headers.get("x-signature");
    if (signature === null) throw signatureError("lemonSqueezy");
    const active = await verifyHmacHex(input.secret.active, input.rawBody, signature);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await verifyHmacHex(input.secret.previous, input.rawBody, signature));
    if (!active && !previous) throw signatureError("lemonSqueezy");
    const root = decodeRoot(input.rawBody);
    const meta = object(root.meta, "lemonSqueezy", "lemonSqueezy.webhook.verify");
    if (meta.test_mode !== undefined && meta.test_mode !== (input.environment === "test"))
      throw signatureError("lemonSqueezy");
    const data = object(root.data, "lemonSqueezy", "lemonSqueezy.webhook.verify");
    const attributes = object(data.attributes, "lemonSqueezy", "lemonSqueezy.webhook.verify");
    if (
      attributes.test_mode !== undefined &&
      attributes.test_mode !== (input.environment === "test")
    )
      throw signatureError("lemonSqueezy");
    const digest = await sha256(input.rawBody);
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "lemonSqueezy",
      environment: input.environment,
      deliveryKey: `lemonSqueezy:${digest}`,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const meta = object(root.meta, "lemonSqueezy", "lemonSqueezy.webhook.decode");
    const data = object(root.data, "lemonSqueezy", "lemonSqueezy.webhook.decode");
    const attributes = object(data.attributes, "lemonSqueezy", "lemonSqueezy.webhook.decode");
    const occurredAt =
      optionalString(attributes, "updated_at") ?? optionalString(attributes, "created_at");
    return {
      type: stringField(meta, "event_name", "lemonSqueezy", "lemonSqueezy.webhook.decode"),
      externalIds: {
        event: event.deliveryKey,
        object: stringField(data, "id", "lemonSqueezy", "lemonSqueezy.webhook.decode"),
      },
      ...(occurredAt === undefined ? {} : { occurredAt: parseIsoDateTime(occurredAt) }),
      payload: data,
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
    throw signatureError("lemonSqueezy");
  }
  return object(value, "lemonSqueezy", "lemonSqueezy.webhook.decode");
}

async function sha256(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    order_created: { type: "payment.succeeded.v1", aggregate: "order" },
    order_refunded: { type: "refund.succeeded.v1", aggregate: "order" },
    subscription_created: { type: "subscription.created.v1", aggregate: "subscription" },
    subscription_updated: { type: "subscription.changed.v1", aggregate: "subscription" },
    subscription_cancelled: { type: "subscription.changed.v1", aggregate: "subscription" },
    subscription_expired: { type: "subscription.canceled.v1", aggregate: "subscription" },
  };
  return map[type];
}
