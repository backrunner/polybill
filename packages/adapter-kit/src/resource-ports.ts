import type {
  BillingInterval,
  CustomerId,
  IsoDateTime,
  Money,
  PriceModel,
  SubscriptionStatus,
} from "@polybill/core";
import type { ProviderContext } from "./context.js";
import type { ProviderOperationResult } from "./ports.js";

export interface ProviderProductSnapshot {
  readonly externalId: string;
  readonly name: string;
  readonly description?: string;
  readonly status: "active" | "archived" | "unknown";
  readonly rawStatus?: string;
}

export interface ProviderPriceSnapshot {
  readonly externalId: string;
  readonly externalProductId: string;
  readonly model: PriceModel;
  readonly status: "active" | "retired" | "unknown";
  readonly rawStatus?: string;
}

export interface CatalogProvider {
  createProduct?(
    context: ProviderContext,
    input: {
      readonly name: string;
      readonly description?: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderProductSnapshot>>;
  getProduct?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderProductSnapshot>>;
  updateProduct?(
    context: ProviderContext,
    externalId: string,
    input: {
      readonly name?: string;
      readonly description?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderProductSnapshot>>;
  archiveProduct?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderProductSnapshot>>;
  createPrice?(
    context: ProviderContext,
    input: {
      readonly externalProductId: string;
      readonly model: PriceModel;
      readonly taxBehavior: "inclusive" | "exclusive" | "unspecified";
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderPriceSnapshot>>;
  getPrice?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderPriceSnapshot>>;
  retirePrice?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderPriceSnapshot>>;
}

export interface ProviderCustomerSnapshot {
  readonly externalId: string;
  readonly email?: string;
  readonly name?: string;
  readonly status: "active" | "tombstoned" | "unknown";
}

export interface CustomerProvider {
  create?(
    context: ProviderContext,
    input: {
      readonly email?: string;
      readonly name?: string;
      readonly externalReference: CustomerId;
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderCustomerSnapshot>>;
  get?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderCustomerSnapshot>>;
  update?(
    context: ProviderContext,
    externalId: string,
    input: {
      readonly email?: string;
      readonly name?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderCustomerSnapshot>>;
  tombstone?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderCustomerSnapshot>>;
  portal?(
    context: ProviderContext,
    externalId: string,
    returnUrl: string,
  ): Promise<ProviderOperationResult<{ readonly url: string; readonly expiresAt?: IsoDateTime }>>;
}

export interface ProviderSubscriptionItem {
  readonly externalPriceId: string;
  readonly quantity: number;
}

export interface ProviderSubscriptionSnapshot {
  readonly externalId: string;
  readonly externalCustomerId: string;
  readonly status: SubscriptionStatus | "unknown";
  readonly items: readonly ProviderSubscriptionItem[];
  readonly currentPeriodStart?: IsoDateTime;
  readonly currentPeriodEnd?: IsoDateTime;
  readonly cancelAtPeriodEnd: boolean;
  readonly rawStatus: string;
}

export interface SubscriptionProvider {
  create?(
    context: ProviderContext,
    input: {
      readonly externalCustomerId: string;
      readonly items: readonly ProviderSubscriptionItem[];
      readonly trial?: BillingInterval;
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
  get?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
  changeItems?(
    context: ProviderContext,
    externalId: string,
    items: readonly ProviderSubscriptionItem[],
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
  pause?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
  resume?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
  cancel?(
    context: ProviderContext,
    externalId: string,
    timing: "immediately" | "period_end",
  ): Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>;
}

export interface ProviderRefundSnapshot {
  readonly externalId: string;
  readonly externalPaymentId: string;
  readonly amount: Money;
  readonly status: "pending" | "succeeded" | "failed" | "canceled" | "unknown";
  readonly rawStatus: string;
}

export interface RefundProvider {
  create?(
    context: ProviderContext,
    input: {
      readonly externalPaymentId: string;
      readonly amount?: Money;
      readonly reason?: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<ProviderOperationResult<ProviderRefundSnapshot>>;
  get?(
    context: ProviderContext,
    externalId: string,
  ): Promise<ProviderOperationResult<ProviderRefundSnapshot>>;
}
