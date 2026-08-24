import type {
  Discount,
  DiscountId,
  DiscountRedemptionId,
  ConnectionId,
  IdempotencyKey,
  IsoDateTime,
  OrderId,
  TenantId,
} from "@polybill/core";

export type CreateDiscountResult =
  | { readonly kind: "created"; readonly discount: Discount }
  | { readonly kind: "replay"; readonly discount: Discount }
  | { readonly kind: "conflict" };

export type ArchiveDiscountResult =
  | { readonly kind: "archived"; readonly discount: Discount }
  | { readonly kind: "replay"; readonly discount: Discount }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export interface DiscountStore {
  createDiscount(
    tenantId: TenantId,
    discount: Discount,
    idempotencyKey: IdempotencyKey,
    payloadHash: string,
  ): Promise<CreateDiscountResult>;
  getDiscount(tenantId: TenantId, discountId: DiscountId): Promise<Discount | undefined>;
  findDiscountByCode(tenantId: TenantId, code: string): Promise<Discount | undefined>;
  archiveDiscount(input: {
    readonly tenantId: TenantId;
    readonly discountId: DiscountId;
    readonly idempotencyKey: IdempotencyKey;
    readonly payloadHash: string;
  }): Promise<ArchiveDiscountResult>;
}

export interface DiscountReservation {
  readonly id: DiscountRedemptionId;
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly discountId: DiscountId;
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadHash: string;
  readonly customerRef?: string;
  readonly status: "reserved" | "finalized" | "released";
  readonly redemptionCountBefore: number;
  readonly customerRedemptionCountBefore: number;
  readonly reservedAt: IsoDateTime;
  readonly finalizedAt?: IsoDateTime;
  readonly orderId?: OrderId;
}

export type ReserveDiscountResult =
  | { readonly kind: "reserved"; readonly reservation: DiscountReservation }
  | { readonly kind: "replay"; readonly reservation: DiscountReservation }
  | { readonly kind: "not_found" }
  | { readonly kind: "inactive" }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "conflict" };

export interface DiscountRedemptionStore {
  reserveDiscount(input: {
    readonly tenantId: TenantId;
    readonly connectionId: ConnectionId;
    readonly reservationId: DiscountRedemptionId;
    readonly discountId: DiscountId;
    readonly idempotencyKey: IdempotencyKey;
    readonly payloadHash: string;
    readonly customerRef?: string;
    readonly maxRedemptions?: number;
    readonly maxRedemptionsPerCustomer?: number;
    readonly reservedAt: IsoDateTime;
  }): Promise<ReserveDiscountResult>;
  releaseDiscountReservation(
    tenantId: TenantId,
    reservationId: DiscountRedemptionId,
  ): Promise<void>;
}
