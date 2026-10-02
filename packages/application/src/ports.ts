import type {
  CheckoutSession,
  ConnectionId,
  ConnectionRef,
  DiscountRedemptionId,
  EvidenceId,
  IdempotencyKey,
  IsoDateTime,
  Order,
  Payment,
  Price,
  ProviderName,
  TenantId,
} from "@polybill/core";
import type { DiscountRedemptionStore, DiscountStore } from "./discount-ports.js";

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

export interface MappingReader {
  getExternalId(
    tenantId: TenantId,
    connectionId: ConnectionId,
    entityType: string,
    entityId: string,
  ): Promise<string | undefined>;
  findCanonicalId(
    tenantId: TenantId,
    connectionId: ConnectionId,
    entityType: string,
    externalId: string,
  ): Promise<string | undefined>;
}

export type ReconciliationEntityType = "customer" | "subscription" | "refund";

export interface ReconciliationTarget {
  readonly entityType: ReconciliationEntityType;
  readonly entityId: string;
  readonly externalId: string;
}

export interface ReconciliationStore {
  listReconciliationTargets(input: {
    readonly tenantId: TenantId;
    readonly connectionId: ConnectionId;
    readonly after?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly ReconciliationTarget[]; readonly nextCursor?: string }>;
  getReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: ConnectionId;
    readonly stream: string;
  }): Promise<{ readonly cursor?: string; readonly sequence: number } | undefined>;
  saveReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: ConnectionId;
    readonly stream: string;
    readonly cursor?: string;
    readonly sequence: number;
    readonly observedAt: IsoDateTime;
  }): Promise<void>;
}

export interface ResourceCommit {
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly provider: ProviderName;
  readonly entityType: string;
  readonly entityId: string;
  readonly externalId?: string;
  readonly value: unknown;
  readonly evidence?: unknown;
  readonly occurredAt: IsoDateTime;
}

export interface CanonicalResourceStore {
  /** Idempotent insert that never replaces an existing canonical snapshot. */
  insertResource(commit: ResourceCommit): Promise<void>;
  replaceResource(commit: ResourceReplacement): Promise<void>;
  commitResource(commit: ResourceCommit): Promise<void>;
  commitResources(commits: readonly ResourceCommit[]): Promise<void>;
  getResource<T>(tenantId: TenantId, entityType: string, entityId: string): Promise<T | undefined>;
}

export interface ResourceReplacement extends ResourceCommit {
  readonly externalId: string;
  readonly expectedVersion: number;
  readonly value: { readonly version: number };
}

export interface CheckoutCommit {
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly provider: ProviderName;
  readonly externalCheckoutId: string;
  readonly externalPaymentId?: string;
  readonly checkout: CheckoutSession;
  readonly order: Order;
  readonly payment: Payment;
  readonly evidenceId: EvidenceId;
  readonly evidence: unknown;
  readonly occurredAt: IsoDateTime;
  readonly discountReservationId?: DiscountRedemptionId;
}

export interface CheckoutStore {
  commitCheckout(commit: CheckoutCommit): Promise<void>;
  getCheckout(tenantId: TenantId, checkoutId: string): Promise<CheckoutSession | undefined>;
}

export interface ApplicationStore
  extends
    IdempotencyStore,
    CatalogReader,
    MappingReader,
    CheckoutStore,
    CanonicalResourceStore,
    ReconciliationStore,
    DiscountStore,
    DiscountRedemptionStore {
  bindConnection(connection: ConnectionRef): Promise<void>;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface Logger {
  info(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  warn(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  error(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}
