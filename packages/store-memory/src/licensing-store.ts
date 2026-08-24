import {
  compareMoney,
  subtractMoney,
  type LicenseId,
  type TenantId,
  type VoucherBatchId,
} from "@polybill/core";
import type {
  ActivateLicenseResult,
  CreateVoucherBatchResult,
  IssueLicenseResult,
  LicenseInstance,
  LicenseRecord,
  LicensingStore,
  RedeemVoucherResult,
  VoucherBatch,
  VoucherRecord,
  VoucherRedemption,
} from "@polybill/licensing";
import { MemoryEntitlementStore } from "./entitlement-store.js";

interface Issuance<T> {
  readonly payloadHash: string;
  readonly value: T;
}

export class MemoryLicensingStore extends MemoryEntitlementStore implements LicensingStore {
  readonly #licenses = new Map<string, LicenseRecord>();
  readonly #licenseIssuance = new Map<string, Issuance<LicenseRecord>>();
  readonly #instances = new Map<string, LicenseInstance>();
  readonly #voucherIssuance = new Map<
    string,
    Issuance<{ batch: VoucherBatch; vouchers: readonly VoucherRecord[] }>
  >();
  readonly #vouchers = new Map<string, VoucherRecord>();
  readonly #batches = new Map<string, VoucherBatch>();
  readonly #redemptions = new Map<string, { payload: string; value: VoucherRedemption }>();

  constructor() {
    super();
  }

  async issueLicense(
    record: LicenseRecord,
    issuanceKey: string,
    payloadHash: string,
  ): Promise<IssueLicenseResult> {
    const key = `${record.tenantId}:${issuanceKey}`;
    const existing = this.#licenseIssuance.get(key);
    if (existing !== undefined)
      return existing.payloadHash === payloadHash
        ? { kind: "replay", record: clone(existing.value) }
        : { kind: "conflict" };
    const grant = await this.getEntitlementGrant(record.tenantId, record.grantId);
    if (
      grant?.status !== "active" ||
      (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(record.issuedAt))
    )
      return { kind: "grant_inactive" };
    const digestKey = `${record.tenantId}:${record.digest}`;
    if (this.#licenses.has(digestKey)) throw new Error("License digest collision");
    this.#licenses.set(digestKey, clone(record));
    this.#licenseIssuance.set(key, { payloadHash, value: clone(record) });
    return { kind: "created", record: clone(record) };
  }

  async findLicense(tenantId: TenantId, digest: string): Promise<LicenseRecord | undefined> {
    const found = this.#licenses.get(`${tenantId}:${digest}`);
    return found === undefined ? undefined : clone(found);
  }

  async activateLicense(
    input: Parameters<LicensingStore["activateLicense"]>[0],
  ): Promise<ActivateLicenseResult> {
    const license = this.#licenses.get(`${input.tenantId}:${input.digest}`);
    if (license === undefined) return { kind: "not_found" };
    const grant = await this.getEntitlementGrant(input.tenantId, license.grantId);
    if (grant?.status !== "active") return { kind: "inactive" };
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(input.now))
      return { kind: "expired" };
    if (license.status !== "active") return { kind: "inactive" };
    if (license.expiresAt !== undefined && Date.parse(license.expiresAt) <= Date.parse(input.now))
      return { kind: "expired" };
    const key = `${input.tenantId}:${license.id}:${input.instance.instanceRef}`;
    const existing = this.#instances.get(key);
    if (existing !== undefined && existing.deactivatedAt === undefined) {
      if (existing.deviceDigest !== input.instance.deviceDigest) return { kind: "conflict" };
      const refreshed = { ...existing, lastValidatedAt: input.now };
      this.#instances.set(key, refreshed);
      return { kind: "replay", instance: clone(refreshed) };
    }
    const activeCount = [...this.#instances.values()].filter(
      (item) =>
        item.tenantId === input.tenantId &&
        item.licenseId === license.id &&
        item.deactivatedAt === undefined,
    ).length;
    if (activeCount >= license.activationLimit) return { kind: "limit_reached" };
    const instance: LicenseInstance = { ...input.instance, licenseId: license.id };
    this.#instances.set(key, clone(instance));
    return { kind: "activated", instance: clone(instance) };
  }

  async deactivateLicense(
    tenantId: TenantId,
    licenseId: LicenseId,
    instanceRef: string,
    now: LicenseInstance["lastValidatedAt"],
  ): Promise<boolean> {
    const key = `${tenantId}:${licenseId}:${instanceRef}`;
    const existing = this.#instances.get(key);
    if (existing === undefined || existing.deactivatedAt !== undefined) return false;
    this.#instances.set(key, { ...existing, deactivatedAt: now });
    return true;
  }

  async createVoucherBatch(
    batch: VoucherBatch,
    vouchers: readonly VoucherRecord[],
    issuanceKey: string,
    payloadHash: string,
  ): Promise<CreateVoucherBatchResult> {
    const key = `${batch.tenantId}:${issuanceKey}`;
    const existing = this.#voucherIssuance.get(key);
    if (existing !== undefined)
      return existing.payloadHash === payloadHash
        ? {
            kind: "replay",
            batch: clone(existing.value.batch),
            vouchers: clone(existing.value.vouchers),
          }
        : { kind: "conflict" };
    for (const voucher of vouchers)
      if (this.#vouchers.has(`${batch.tenantId}:${voucher.digest}`))
        throw new Error("Voucher digest collision");
    this.#batches.set(`${batch.tenantId}:${batch.id}`, clone(batch));
    for (const voucher of vouchers)
      this.#vouchers.set(`${batch.tenantId}:${voucher.digest}`, clone(voucher));
    this.#voucherIssuance.set(key, {
      payloadHash,
      value: { batch: clone(batch), vouchers: clone(vouchers) },
    });
    return { kind: "created", batch: clone(batch), vouchers: clone(vouchers) };
  }

  async getVoucherBatch(
    tenantId: TenantId,
    batchId: VoucherBatchId,
  ): Promise<VoucherBatch | undefined> {
    const batch = this.#batches.get(`${tenantId}:${batchId}`);
    return batch === undefined ? undefined : clone(batch);
  }

  async redeemVoucher(
    input: Parameters<LicensingStore["redeemVoucher"]>[0],
  ): Promise<RedeemVoucherResult> {
    const idempotencyKey = `${input.tenantId}:${input.redemption.idempotencyKey}`;
    const payload = JSON.stringify([
      input.digest,
      input.redemption.beneficiaryRef,
      input.redemption.value ?? null,
    ]);
    const replay = this.#redemptions.get(idempotencyKey);
    if (replay !== undefined) {
      if (replay.payload !== payload) return { kind: "conflict" };
      const voucher = [...this.#vouchers.values()].find(
        (item) => item.id === replay.value.voucherId,
      );
      if (voucher === undefined) throw new Error("Redemption voucher is missing");
      return { kind: "replay", voucher: clone(voucher), redemption: clone(replay.value) };
    }
    const key = `${input.tenantId}:${input.digest}`;
    const voucher = this.#vouchers.get(key);
    if (voucher === undefined) return { kind: "not_found" };
    if (
      voucher.status === "expired" ||
      (voucher.expiresAt !== undefined && Date.parse(voucher.expiresAt) <= Date.parse(input.now))
    )
      return { kind: "expired" };
    if (voucher.status === "revoked") return { kind: "inactive" };
    if (voucher.remainingUses < 1 || voucher.status === "redeemed") return { kind: "exhausted" };
    let remainingValue = voucher.remainingValue;
    if (remainingValue === undefined && input.redemption.value !== undefined)
      return { kind: "conflict" };
    if (remainingValue !== undefined) {
      const value = input.redemption.value;
      if (value === undefined || value.amount === "0") return { kind: "conflict" };
      try {
        if (compareMoney(value, remainingValue) > 0) return { kind: "insufficient_value" };
        remainingValue = subtractMoney(remainingValue, value);
      } catch {
        return { kind: "conflict" };
      }
    }
    const remainingUses = voucher.remainingUses - 1;
    const exhausted = remainingUses === 0 || remainingValue?.amount === "0";
    const updated: VoucherRecord = {
      ...voucher,
      remainingUses,
      ...(remainingValue === undefined ? {} : { remainingValue }),
      status: exhausted ? "redeemed" : "partially_redeemed",
    };
    const redemption: VoucherRedemption = { ...input.redemption, voucherId: voucher.id };
    this.#vouchers.set(key, clone(updated));
    this.#redemptions.set(idempotencyKey, { payload, value: clone(redemption) });
    return { kind: "redeemed", voucher: clone(updated), redemption: clone(redemption) };
  }
}

export function createMemoryLicensingStore(): MemoryLicensingStore {
  return new MemoryLicensingStore();
}
function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
