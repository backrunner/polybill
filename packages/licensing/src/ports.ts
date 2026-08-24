import type { IsoDateTime, LicenseId, TenantId } from "@polybill/core";
import type {
  LicenseInstance,
  LicenseRecord,
  VoucherBatch,
  VoucherRecord,
  VoucherRedemption,
} from "./domain.js";

export type IssueLicenseResult =
  | { readonly kind: "created" | "replay"; readonly record: LicenseRecord }
  | { readonly kind: "conflict" };

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
  redeemVoucher(input: {
    readonly tenantId: TenantId;
    readonly digest: string;
    readonly redemption: Omit<VoucherRedemption, "voucherId">;
    readonly now: IsoDateTime;
  }): Promise<RedeemVoucherResult>;
}

export interface LicensingStore extends LicenseStore, VoucherStore {}

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
