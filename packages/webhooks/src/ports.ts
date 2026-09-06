import type { DecodedProviderEvent, VerifiedProviderEvent } from "@polybill/adapter-kit";
import type {
  CanonicalBillingEvent,
  ConnectionRef,
  IsoDateTime,
  ProviderName,
  TenantId,
} from "@polybill/core";

export interface WebhookConnection {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly secret: {
    readonly active: string;
    readonly activeKeyId: string;
    readonly previous?: string;
    readonly previousKeyId?: string;
  };
}

export interface WebhookConnectionResolver {
  resolve(input: {
    readonly provider: string;
    readonly connectionId?: string;
    readonly headers: Headers;
  }): Promise<WebhookConnection | undefined>;
}

export interface InboxRecord {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly deliveryKey: string;
  readonly providerEventId?: string;
  readonly receivedAt: IsoDateTime;
  readonly verified: VerifiedProviderEvent;
  readonly decoded?: DecodedProviderEvent;
}

export type InboxClaim = "claimed" | "duplicate_applied" | "duplicate_processing";

export interface WebhookInboxStore {
  claim(record: InboxRecord): Promise<InboxClaim>;
  markQueued(record: InboxRecord): Promise<void>;
  markApplied(record: InboxRecord, events: readonly CanonicalBillingEvent[]): Promise<void>;
  markFailed(record: InboxRecord, errorCode: string, retryable: boolean): Promise<void>;
}

export interface WebhookQueue {
  send(record: InboxRecord): Promise<void>;
}

export function providerSlug(name: ProviderName): string {
  return name === "lemonSqueezy" ? "lemon-squeezy" : name;
}

export function providerName(slug: string): ProviderName | undefined {
  switch (slug) {
    case "stripe":
      return "stripe";
    case "dodo":
      return "dodo";
    case "polar":
      return "polar";
    case "creem":
      return "creem";
    case "waffo":
      return "waffo";
    case "lemon-squeezy":
      return "lemonSqueezy";
    case "paddle":
      return "paddle";
    case "x402":
      return "x402";
    default:
      return undefined;
  }
}
