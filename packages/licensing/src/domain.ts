import type {
  CustomerId,
  EntitlementGrantId,
  EntitlementPolicyId,
  IsoDateTime,
  LicenseId,
  LicenseInstanceId,
  Money,
  RedemptionId,
  TenantId,
  VoucherBatchId,
  VoucherId,
} from "@polybill/core";

export interface EntitlementPolicy {
  readonly id: EntitlementPolicyId;
  readonly benefit: string;
  readonly revokeOn: "refund" | "subscription_end" | "never";
  readonly gracePeriodSeconds: number;
}

export interface EntitlementGrant {
  readonly id: EntitlementGrantId;
  readonly tenantId: TenantId;
  readonly policyId: EntitlementPolicyId;
  readonly source: "order" | "subscription" | "manual" | "voucher" | "migration";
  readonly sourceRef: string;
  readonly status: "pending" | "active" | "suspended" | "revoked" | "expired";
  readonly grantedAt: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
}

export interface LicenseRecord {
  readonly id: LicenseId;
  readonly tenantId: TenantId;
  readonly digest: string;
  readonly encryptedValue: string;
  readonly status: "active" | "suspended" | "revoked" | "expired";
  readonly activationLimit: number;
  readonly expiresAt?: IsoDateTime;
  readonly ownerRef?: CustomerId;
  readonly grantId: EntitlementGrantId;
  readonly issuedAt: IsoDateTime;
}

export interface LicenseInstance {
  readonly id: LicenseInstanceId;
  readonly tenantId: TenantId;
  readonly licenseId: LicenseId;
  readonly instanceRef: string;
  readonly deviceDigest: string;
  readonly activatedAt: IsoDateTime;
  readonly lastValidatedAt: IsoDateTime;
  readonly deactivatedAt?: IsoDateTime;
}

export type VoucherBenefit =
  | { readonly kind: "entitlement"; readonly policyId: EntitlementPolicyId }
  | { readonly kind: "credit"; readonly initialValue: Money };

export interface VoucherBatch {
  readonly id: VoucherBatchId;
  readonly tenantId: TenantId;
  readonly prefix: string;
  readonly quantity: number;
  readonly maxUses: number;
  readonly benefit: VoucherBenefit;
  readonly createdAt: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
}

export interface VoucherRecord {
  readonly id: VoucherId;
  readonly tenantId: TenantId;
  readonly batchId: VoucherBatchId;
  readonly digest: string;
  readonly encryptedValue: string;
  readonly status: "active" | "partially_redeemed" | "redeemed" | "expired" | "revoked";
  readonly remainingUses: number;
  readonly remainingValue?: Money;
  readonly expiresAt?: IsoDateTime;
}

export interface VoucherRedemption {
  readonly id: RedemptionId;
  readonly tenantId: TenantId;
  readonly voucherId: VoucherId;
  readonly idempotencyKey: string;
  readonly beneficiaryRef: string;
  readonly value?: Money;
  readonly redeemedAt: IsoDateTime;
}
