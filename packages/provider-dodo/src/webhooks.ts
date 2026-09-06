import {
  assertWebhookTimestamp,
  canonicalWebhookEvent,
  decodeBase64,
  joinBytes,
  object,
  optionalString,
  signatureError,
  utf8,
  verifyHmacBase64,
  type WebhookProvider,
} from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";

export const dodoWebhooks: WebhookProvider = {
  async verify(input) {
    const messageId = input.headers.get("webhook-id");
    const timestampText = input.headers.get("webhook-timestamp");
    const signatures = (input.headers.get("webhook-signature") ?? "")
      .split(" ")
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => value.startsWith("v1,"))
      .map((value) => value.slice(3));
    if (messageId === null || timestampText === null || signatures.length === 0)
      throw signatureError("dodo");
    const timestamp = Number(timestampText);
    assertWebhookTimestamp(timestamp, input.now, 300, "dodo");
    const message = joinBytes(utf8(`${messageId}.${timestamp}.`), input.rawBody);
    const active = await standardMatches(input.secret.active, signatures, message);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await standardMatches(input.secret.previous, signatures, message));
    if (!active && !previous) throw signatureError("dodo");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "dodo",
      environment: input.environment,
      deliveryKey: `dodo:${messageId}`,
      providerEventId: messageId,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const payload = object(root.data, "dodo", "dodo.webhook.decode");
    const type = optionalString(root, "type") ?? "unknown";
    const externalId = externalObjectId(payload, type);
    const timestamp = optionalString(root, "timestamp") ?? optionalString(root, "created_at");
    return {
      type,
      externalIds: {
        ...(event.providerEventId === undefined ? {} : { event: event.providerEventId }),
        ...(externalId === undefined ? {} : { object: externalId }),
      },
      ...(timestamp === undefined ? {} : { occurredAt: parseIsoDateTime(timestamp) }),
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

async function standardMatches(
  secret: string,
  signatures: readonly string[],
  message: Uint8Array,
): Promise<boolean> {
  let key: Uint8Array;
  try {
    key = decodeBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  for (const signature of signatures)
    if (await verifyHmacBase64(key, message, signature)) return true;
  return false;
}

function decodeRoot(rawBody: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw signatureError("dodo");
  }
  return object(value, "dodo", "dodo.webhook.decode");
}

function externalObjectId(
  value: Readonly<Record<string, unknown>>,
  type: string,
): string | undefined {
  const resource = type.split(".")[0];
  if (
    resource === undefined ||
    !["payment", "subscription", "refund", "license_key", "customer", "product"].includes(resource)
  )
    return optionalString(value, "id");
  return optionalString(value, `${resource}_id`);
}

function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "payment.succeeded": { type: "payment.succeeded.v1", aggregate: "payment" },
    "payment.failed": { type: "payment.failed.v1", aggregate: "payment" },
    "refund.succeeded": { type: "refund.succeeded.v1", aggregate: "refund" },
    "subscription.active": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.cancelled": { type: "subscription.canceled.v1", aggregate: "subscription" },
  };
  return map[type];
}
