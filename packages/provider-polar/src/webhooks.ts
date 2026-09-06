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

export const polarWebhooks: WebhookProvider = {
  async verify(input) {
    const id = input.headers.get("webhook-id");
    const timestampText = input.headers.get("webhook-timestamp");
    const signatures = (input.headers.get("webhook-signature") ?? "")
      .split(" ")
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => value.startsWith("v1,"))
      .map((value) => value.slice(3));
    if (id === null || timestampText === null || signatures.length === 0)
      throw signatureError("polar");
    const timestamp = Number(timestampText);
    assertWebhookTimestamp(timestamp, input.now, 300, "polar");
    const message = joinBytes(utf8(`${id}.${timestamp}.`), input.rawBody);
    const active = await matchesPolarSecret(input.secret.active, signatures, message);
    const previous =
      !active &&
      input.secret.previous !== undefined &&
      (await matchesPolarSecret(input.secret.previous, signatures, message));
    if (!active && !previous) throw signatureError("polar");
    const keyId = active ? input.secret.activeKeyId : input.secret.previousKeyId;
    return {
      provider: "polar",
      environment: input.environment,
      deliveryKey: `polar:${id}`,
      providerEventId: id,
      rawBody: input.rawBody,
      verifiedAt: input.now,
      ...(keyId === undefined ? {} : { keyId }),
    };
  },
  decode(event) {
    const root = decodeRoot(event.rawBody);
    const payload = object(root.data, "polar", "polar.webhook.decode");
    const objectId = optionalString(payload, "id");
    const occurredAt =
      optionalString(payload, "modified_at") ?? optionalString(payload, "created_at");
    return {
      type: optionalString(root, "type") ?? "unknown",
      externalIds: {
        ...(event.providerEventId === undefined ? {} : { event: event.providerEventId }),
        ...(objectId === undefined ? {} : { object: objectId }),
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
  const key = new TextEncoder().encode(secret);
  for (const signature of signatures)
    if (await verifyHmacBase64(key, message, signature)) return true;
  return false;
}

async function matchesPolarSecret(
  secret: string,
  signatures: readonly string[],
  message: Uint8Array,
): Promise<boolean> {
  // Match Polar's documented rollout: legacy UTF-8 keys and new Standard Webhooks keys.
  if (await matches(secret, signatures, message)) return true;
  if (!secret.startsWith("whsec_")) return false;
  let key: Uint8Array;
  try {
    key = decodeBase64(secret.slice(6));
  } catch {
    return false;
  }
  for (const signature of signatures)
    if (await verifyHmacBase64(key, message, signature)) return true;
  return false;
}

function decodeRoot(raw: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw signatureError("polar");
  }
  return object(value, "polar", "polar.webhook.decode");
}

function mappingFor(
  type: string,
): { readonly type: string; readonly aggregate: string } | undefined {
  const map: Readonly<Record<string, { readonly type: string; readonly aggregate: string }>> = {
    "checkout.updated": { type: "checkout.changed.v1", aggregate: "checkout" },
    "checkout.expired": { type: "checkout.expired.v1", aggregate: "checkout" },
    "order.paid": { type: "payment.succeeded.v1", aggregate: "order" },
    "subscription.created": { type: "subscription.created.v1", aggregate: "subscription" },
    "subscription.updated": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.canceled": { type: "subscription.changed.v1", aggregate: "subscription" },
    "subscription.revoked": { type: "subscription.canceled.v1", aggregate: "subscription" },
    "refund.created": { type: "refund.created.v1", aggregate: "refund" },
  };
  return map[type];
}
