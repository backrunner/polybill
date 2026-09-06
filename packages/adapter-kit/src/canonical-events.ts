import { parseId, type CanonicalBillingEvent } from "@polybill/core";
import type { DecodedProviderEvent, WebhookMapContext } from "./ports.js";

export async function canonicalWebhookEvent(input: {
  readonly event: DecodedProviderEvent;
  readonly context: WebhookMapContext;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
}): Promise<CanonicalBillingEvent> {
  const source = JSON.stringify([
    input.context.tenantId,
    input.context.connection.id,
    input.context.connection.environment,
    input.context.connection.provider,
    input.event.externalIds.event ?? input.event.payload,
    input.event.type,
    input.type,
    input.aggregateType,
    input.aggregateId,
  ]);
  const digest = Array.from(
    new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    id: parseId<"EventId">(`evt_${digest.slice(0, 24)}`, "evt"),
    schemaVersion: 1,
    type: input.type,
    tenantId: input.context.tenantId,
    connectionId: input.context.connection.id,
    environment: input.context.connection.environment,
    aggregate: { type: input.aggregateType, id: input.aggregateId },
    occurredAt: input.event.occurredAt ?? input.context.observedAt,
    observedAt: input.context.observedAt,
    data: { externalIds: input.event.externalIds, providerEventType: input.event.type },
    evidenceRef: parseId<"EvidenceId">(`evi_${digest.slice(24, 48)}`, "evi"),
  };
}
