import type { PriceModel } from "./catalog.js";
import type {
  CheckoutId,
  CustomerId,
  EvidenceId,
  OrderId,
  PaymentId,
  PriceId,
  RefundId,
  SettlementQuoteId,
  SkuId,
} from "./ids.js";
import type { AssetAmount, Money } from "./money.js";
import type { IsoDateTime } from "./time.js";

export interface Customer {
  readonly id: CustomerId;
  readonly externalId: string;
  readonly email?: string;
  readonly name?: string;
  readonly status: "active" | "tombstoned";
}

export interface OrderLineSnapshot {
  readonly skuId: SkuId;
  readonly priceId?: PriceId;
  readonly price: PriceModel;
  readonly quantity: number;
  readonly subtotal: Money;
}

export type OrderPaymentStatus =
  "pending" | "paid" | "partially_refunded" | "refunded" | "failed" | "canceled" | "disputed";

export type FulfillmentStatus = "unfulfilled" | "processing" | "fulfilled" | "revoked";

export interface Order {
  readonly id: OrderId;
  readonly externalId?: string;
  readonly customerId?: CustomerId;
  readonly lines: readonly OrderLineSnapshot[];
  readonly total: Money;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly commercialTermsRef: EvidenceId;
  readonly createdAt: IsoDateTime;
}

export type CheckoutStatus = "open" | "complete" | "expired" | "canceled";

export interface CheckoutSession {
  readonly id: CheckoutId;
  readonly orderId: OrderId;
  readonly status: CheckoutStatus;
  readonly url?: string;
  readonly expiresAt?: IsoDateTime;
}

export type PaymentStatus =
  "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "canceled";

export interface PaymentEvidence {
  readonly authority: "provider_api" | "provider_event" | "x402_receipt" | "chain";
  readonly observedAt: IsoDateTime;
  readonly finality: "provisional" | "confirmed" | "finalized";
  readonly reference: string;
}

export interface Payment {
  readonly id: PaymentId;
  readonly orderId: OrderId;
  readonly status: PaymentStatus;
  readonly amount: Money;
  readonly refundedAmount: Money;
  readonly settlementQuoteId?: SettlementQuoteId;
  readonly settledAssetAmount?: AssetAmount;
  readonly evidence: readonly PaymentEvidence[];
}

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ["requires_action", "processing", "succeeded", "failed", "canceled"],
  requires_action: ["processing", "succeeded", "failed", "canceled"],
  processing: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function transitionPayment(payment: Payment, status: PaymentStatus): Payment {
  if (payment.status === status) return payment;
  if (!PAYMENT_TRANSITIONS[payment.status].includes(status)) {
    throw new RangeError(`Invalid payment transition: ${payment.status} -> ${status}`);
  }
  return { ...payment, status };
}

export type RefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

export interface Refund {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly amount: Money;
  readonly status: RefundStatus;
  readonly evidence: readonly PaymentEvidence[];
}
