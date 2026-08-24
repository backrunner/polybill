import type {
  CheckoutSession,
  ConnectionId,
  EvidenceId,
  IdempotencyKey,
  IsoDateTime,
  Order,
  Price,
  ProviderName,
  TenantId,
} from "@polybill/core";

export interface IdempotencyScope {
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly operation: string;
  readonly key: IdempotencyKey;
}

export type IdempotencyClaim =
  | { readonly kind: "claimed"; readonly leaseToken: string }
  | { readonly kind: "in_progress" }
  | {
      readonly kind: "outcome_unknown";
      readonly leaseToken: string;
      readonly recoveryContext: unknown;
      readonly evidence?: string;
    }
  | { readonly kind: "replay"; readonly result: unknown }
  | { readonly kind: "conflict" };

export interface IdempotencyStore {
  claim(scope: IdempotencyScope, payloadHash: string): Promise<IdempotencyClaim>;
  saveRecoveryContext(
    scope: IdempotencyScope,
    leaseToken: string,
    recoveryContext: unknown,
  ): Promise<void>;
  complete(scope: IdempotencyScope, leaseToken: string, result: unknown): Promise<void>;
  markUnknown(scope: IdempotencyScope, leaseToken: string, evidence?: string): Promise<void>;
  release(scope: IdempotencyScope, leaseToken: string): Promise<void>;
}

export interface CatalogReader {
  getPrice(tenantId: TenantId, priceId: string): Promise<Price | undefined>;
}

export interface CheckoutCommit {
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly provider: ProviderName;
  readonly externalCheckoutId: string;
  readonly checkout: CheckoutSession;
  readonly order: Order;
  readonly evidenceId: EvidenceId;
  readonly evidence: unknown;
  readonly occurredAt: IsoDateTime;
}

export interface CheckoutStore {
  commitCheckout(commit: CheckoutCommit): Promise<void>;
  getCheckout(tenantId: TenantId, checkoutId: string): Promise<CheckoutSession | undefined>;
}

export interface ApplicationStore extends IdempotencyStore, CatalogReader, CheckoutStore {}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface Logger {
  info(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  warn(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  error(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}
