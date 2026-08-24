import type {
  AssetAmount,
  CanonicalBillingEvent,
  CustomerId,
  Environment,
  IsoDateTime,
  Money,
  OrderId,
  PriceModel,
  ProviderName,
  SkuId,
} from "@polybill/core";
import type { CapabilitySnapshot } from "./capabilities.js";
import type { ProviderContext } from "./context.js";

export interface ProviderDescriptor {
  readonly name: ProviderName;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly maturity: "experimental" | "preview" | "stable";
}

export interface PortabilityWarning {
  readonly code: string;
  readonly message: string;
}

export interface ProviderEvidence {
  readonly provider: ProviderName;
  readonly environment: Environment;
  readonly requestId?: string;
  readonly externalId?: string;
  readonly observedAt: IsoDateTime;
  readonly rawStatus?: string;
}

export interface ProviderOperationResult<T> {
  readonly value: T;
  readonly evidence: ProviderEvidence;
  readonly idempotency: "provider" | "polybill" | "both";
  readonly warnings: readonly PortabilityWarning[];
}

export interface ProviderCheckoutLine {
  readonly skuId: SkuId;
  readonly quantity: number;
  readonly price: PriceModel;
  readonly unitAmount: Money;
  readonly externalPriceId?: string;
}

export interface ProviderCheckoutCommand {
  readonly orderId: OrderId;
  readonly customerId?: CustomerId;
  readonly customerEmail?: string;
  readonly lines: readonly ProviderCheckoutLine[];
  readonly total: Money;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderCheckoutSnapshot {
  readonly externalId: string;
  readonly status: "open" | "complete" | "expired" | "canceled" | "unknown";
  readonly url?: string;
  readonly expiresAt?: IsoDateTime;
  readonly rawStatus: string;
}

export interface CheckoutProvider {
  create(
    context: ProviderContext,
    command: ProviderCheckoutCommand,
  ): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>>;
  get(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>>;
  recoverByIdempotencyKey?(
    context: ProviderContext,
    key: string,
  ): Promise<ProviderOperationResult<ProviderCheckoutSnapshot> | undefined>;
}

export interface VerifiedProviderEvent {
  readonly provider: ProviderName;
  readonly environment: Environment;
  readonly deliveryKey: string;
  readonly providerEventId?: string;
  readonly rawBody: Uint8Array;
  readonly verifiedAt: IsoDateTime;
  readonly keyId?: string;
}

export interface DecodedProviderEvent {
  readonly type: string;
  readonly externalIds: Readonly<Record<string, string>>;
  readonly occurredAt?: IsoDateTime;
  readonly payload: unknown;
}

export interface ResolvedWebhookSecret {
  readonly active: string;
  readonly activeKeyId: string;
  readonly previous?: string;
  readonly previousKeyId?: string;
}

export interface WebhookProvider {
  verify(input: {
    readonly rawBody: Uint8Array;
    readonly headers: Headers;
    readonly secret: ResolvedWebhookSecret;
    readonly now: IsoDateTime;
  }): Promise<VerifiedProviderEvent>;
  decode(event: VerifiedProviderEvent): DecodedProviderEvent;
  map(event: DecodedProviderEvent): Promise<readonly CanonicalBillingEvent[]>;
}

export interface ReconcileDifference {
  readonly kind:
    | "missing_local"
    | "missing_remote"
    | "state_mismatch"
    | "amount_mismatch"
    | "mapping_conflict"
    | "unknown_remote_state";
  readonly externalId?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ReconcileProvider {
  checkout(context: ProviderContext, externalId: string): Promise<readonly ReconcileDifference[]>;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  getCapabilities(context: ProviderContext): Promise<CapabilitySnapshot>;
  readonly checkout?: CheckoutProvider;
  readonly webhooks: WebhookProvider;
  readonly reconcile: ReconcileProvider;
}

export interface ProviderAssetSettlement {
  readonly amount: AssetAmount;
  readonly externalReference: string;
}
