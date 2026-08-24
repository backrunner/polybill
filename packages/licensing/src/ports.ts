import type {
  EntitlementGrantId,
  EntitlementPolicyId,
  IsoDateTime,
  LicenseId,
  TenantId,
  VoucherBatchId,
} from "@polybill/core";
import type {
  EntitlementGrant,
  EntitlementPolicy,
  LicenseInstance,
  LicenseRecord,
  VoucherBatch,
  VoucherRecord,
  VoucherRedemption,
} from "./domain.js";

export type CreateEntitlementPolicyResult =
  | { readonly kind: "created" | "replay"; readonly policy: EntitlementPolicy }
  | { readonly kind: "conflict" };

export type CreateEntitlementGrantResult =
  | { readonly kind: "created" | "replay"; readonly grant: EntitlementGrant }
  | { readonly kind: "policy_not_found" }
  | { readonly kind: "conflict" };

export type TransitionEntitlementGrantResult =
  | { readonly kind: "changed" | "replay"; readonly grant: EntitlementGrant }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "conflict" };

export interface EntitlementStore {
  createEntitlementPolicy(
    tenantId: TenantId,
    policy: EntitlementPolicy,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementPolicyResult>;
  getEntitlementPolicy(
    tenantId: TenantId,
    policyId: EntitlementPolicyId,
  ): Promise<EntitlementPolicy | undefined>;
  createEntitlementGrant(
    grant: EntitlementGrant,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementGrantResult>;
  getEntitlementGrant(
    tenantId: TenantId,
    grantId: EntitlementGrantId,
  ): Promise<EntitlementGrant | undefined>;
  transitionEntitlementGrant(input: {
    readonly tenantId: TenantId;
    readonly grantId: EntitlementGrantId;
    readonly expectedStatuses: readonly EntitlementGrant["status"][];
    readonly status: EntitlementGrant["status"];
    readonly idempotencyKey: string;
    readonly updatedAt: IsoDateTime;
  }): Promise<TransitionEntitlementGrantResult>;
}

export type IssueLicenseResult =
  | { readonly kind: "created" | "replay"; readonly record: LicenseRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "grant_inactive" };

export type ActivateLicenseResult =
  | { readonly kind: "activated" | "replay"; readonly instance: LicenseInstance }
  | { readonly kind: "not_found" | "inactive" | "expired" | "limit_reached" | "conflict" };

export interface LicenseStore {
  issueLicense(
    record: LicenseRecord,
    issuanceKey: string,
    payloadHash: string,
  ): Promise<IssueLicenseResult>;
  findLicense(tenantId: TenantId, digest: string): Promise<LicenseRecord | undefined>;
  activateLicense(input: {
    readonly tenantId: TenantId;
    readonly digest: string;
    readonly instance: Omit<LicenseInstance, "licenseId">;
    readonly now: IsoDateTime;
  }): Promise<ActivateLicenseResult>;
  deactivateLicense(
    tenantId: TenantId,
    licenseId: LicenseId,
    instanceRef: string,
    now: IsoDateTime,
  ): Promise<boolean>;
}

export type CreateVoucherBatchResult =
  | {
      readonly kind: "created" | "replay";
      readonly batch: VoucherBatch;
      readonly vouchers: readonly VoucherRecord[];
    }
  | { readonly kind: "conflict" };

export type RedeemVoucherResult =
  | {
      readonly kind: "redeemed" | "replay";
      readonly voucher: VoucherRecord;
      readonly redemption: VoucherRedemption;
    }
  | {
      readonly kind:
        "not_found" | "inactive" | "expired" | "exhausted" | "insufficient_value" | "conflict";
    };

export interface VoucherStore {
  createVoucherBatch(
    batch: VoucherBatch,
    vouchers: readonly VoucherRecord[],
    issuanceKey: string,
    payloadHash: string,
  ): Promise<CreateVoucherBatchResult>;
  getVoucherBatch(tenantId: TenantId, batchId: VoucherBatchId): Promise<VoucherBatch | undefined>;
  redeemVoucher(input: {
    readonly tenantId: TenantId;
    readonly digest: string;
    readonly redemption: Omit<VoucherRedemption, "voucherId">;
    readonly now: IsoDateTime;
  }): Promise<RedeemVoucherResult>;
}

export interface LicensingStore extends EntitlementStore, LicenseStore, VoucherStore {}

export interface LicensingIds {
  next(prefix: string): string;
}

export interface SecretCrypto {
  randomBytes(length: number): Uint8Array;
  digest(value: string): Promise<string>;
  hash(value: string): Promise<string>;
  encrypt(value: string, aad: string): Promise<string>;
  decrypt(value: string, aad: string): Promise<string>;
}
