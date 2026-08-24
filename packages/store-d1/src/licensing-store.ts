import type { LicenseId, TenantId } from "@polybill/core";
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
import type { D1DatabaseLike, D1Result } from "./d1.js";
import {
  decodeLicense,
  decodeLicenseInstance,
  decodeRedemption,
  decodeVoucher,
  decodeVoucherBatch,
} from "./licensing-codecs.js";
import { consumeVoucher, validateVoucher } from "./voucher-logic.js";

export class D1LicensingStore implements LicensingStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async issueLicense(
    record: LicenseRecord,
    issuanceKey: string,
    payloadHash: string,
  ): Promise<IssueLicenseResult> {
    const existing = await this.#licenseByIssuance(record.tenantId, issuanceKey);
    if (existing !== null)
      return existing.payload_hash === payloadHash
        ? { kind: "replay", record: decodeLicense(existing.value) }
        : { kind: "conflict" };
    try {
      await this.#db
        .prepare(
          "INSERT INTO polybill_licenses (tenant_id, license_id, digest, encrypted_value, status, activation_limit, expires_at, grant_id, issuance_key, payload_hash, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          record.tenantId,
          record.id,
          record.digest,
          record.encryptedValue,
          record.status,
          record.activationLimit,
          record.expiresAt ?? null,
          record.grantId,
          issuanceKey,
          payloadHash,
          JSON.stringify(record),
        )
        .run();
      return { kind: "created", record };
    } catch (error) {
      const raced = await this.#licenseByIssuance(record.tenantId, issuanceKey);
      if (raced === null) throw error;
      return raced.payload_hash === payloadHash
        ? { kind: "replay", record: decodeLicense(raced.value) }
        : { kind: "conflict" };
    }
  }

  async findLicense(tenantId: TenantId, digest: string): Promise<LicenseRecord | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_licenses WHERE tenant_id = ? AND digest = ?")
      .bind(tenantId, digest)
      .first<{ value: string }>();
    return row === null ? undefined : decodeLicense(row.value);
  }

  async activateLicense(
    input: Parameters<LicensingStore["activateLicense"]>[0],
  ): Promise<ActivateLicenseResult> {
    const licenseRow = await this.#db
      .prepare(
        "SELECT license_id, status, activation_limit, expires_at, value FROM polybill_licenses WHERE tenant_id = ? AND digest = ?",
      )
      .bind(input.tenantId, input.digest)
      .first<{
        license_id: string;
        status: string;
        activation_limit: number;
        expires_at: string | null;
        value: string;
      }>();
    if (licenseRow === null) return { kind: "not_found" };
    if (licenseRow.status !== "active") return { kind: "inactive" };
    if (
      licenseRow.expires_at !== null &&
      Date.parse(licenseRow.expires_at) <= Date.parse(input.now)
    )
      return { kind: "expired" };
    const replay = await this.#instance(
      input.tenantId,
      licenseRow.license_id,
      input.instance.instanceRef,
    );
    if (replay !== null) return this.#refreshInstance(replay, input);

    const instance: LicenseInstance = {
      ...input.instance,
      licenseId: licenseRow.license_id as LicenseId,
    };
    const inserted = await this.#db
      .prepare(
        `INSERT INTO polybill_license_instances (tenant_id, instance_id, license_id, instance_ref, device_digest, activated_at, last_validated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM polybill_license_instances WHERE tenant_id = ? AND license_id = ? AND deactivated_at IS NULL) < ? ON CONFLICT(tenant_id, license_id, instance_ref) DO NOTHING`,
      )
      .bind(
        input.tenantId,
        instance.id,
        instance.licenseId,
        instance.instanceRef,
        instance.deviceDigest,
        instance.activatedAt,
        instance.lastValidatedAt,
        input.tenantId,
        instance.licenseId,
        licenseRow.activation_limit,
      )
      .run();
    if (changes(inserted) === 1) return { kind: "activated", instance };
    const raced = await this.#instance(
      input.tenantId,
      licenseRow.license_id,
      input.instance.instanceRef,
    );
    return raced === null ? { kind: "limit_reached" } : this.#refreshInstance(raced, input);
  }

  async deactivateLicense(
    tenantId: TenantId,
    licenseId: LicenseId,
    instanceRef: string,
    now: LicenseInstance["lastValidatedAt"],
  ): Promise<boolean> {
    const result = await this.#db
      .prepare(
        "UPDATE polybill_license_instances SET deactivated_at = ? WHERE tenant_id = ? AND license_id = ? AND instance_ref = ? AND deactivated_at IS NULL",
      )
      .bind(now, tenantId, licenseId, instanceRef)
      .run();
    return changes(result) === 1;
  }

  async createVoucherBatch(
    batch: VoucherBatch,
    vouchers: readonly VoucherRecord[],
    issuanceKey: string,
    payloadHash: string,
  ): Promise<CreateVoucherBatchResult> {
    const existing = await this.#voucherBatchByIssuance(batch.tenantId, issuanceKey);
    if (existing !== null) return this.#voucherReplay(existing, payloadHash);
    const statements = [
      this.#db
        .prepare(
          "INSERT INTO polybill_voucher_batches (tenant_id, batch_id, issuance_key, payload_hash, value) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(batch.tenantId, batch.id, issuanceKey, payloadHash, JSON.stringify(batch)),
      ...vouchers.map((voucher) =>
        this.#db
          .prepare(
            "INSERT INTO polybill_vouchers (tenant_id, voucher_id, batch_id, digest, encrypted_value, status, remaining_uses, remaining_amount, remaining_currency, expires_at, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            voucher.tenantId,
            voucher.id,
            voucher.batchId,
            voucher.digest,
            voucher.encryptedValue,
            voucher.status,
            voucher.remainingUses,
            voucher.remainingValue?.amount ?? null,
            voucher.remainingValue?.currency ?? null,
            voucher.expiresAt ?? null,
            JSON.stringify(voucher),
          ),
      ),
    ];
    try {
      await this.#db.batch(statements);
      return { kind: "created", batch, vouchers };
    } catch (error) {
      const raced = await this.#voucherBatchByIssuance(batch.tenantId, issuanceKey);
      if (raced === null) throw error;
      return this.#voucherReplay(raced, payloadHash);
    }
  }

  async redeemVoucher(
    input: Parameters<LicensingStore["redeemVoucher"]>[0],
  ): Promise<RedeemVoucherResult> {
    const requestHash = JSON.stringify([
      input.digest,
      input.redemption.beneficiaryRef,
      input.redemption.value ?? null,
    ]);
    const prior = await this.#redemption(input.tenantId, input.redemption.idempotencyKey);
    if (prior !== null) return this.#redemptionReplay(prior, requestHash);
    const row = await this.#db
      .prepare(
        "SELECT voucher_id, status, remaining_uses, remaining_amount, remaining_currency, expires_at, value FROM polybill_vouchers WHERE tenant_id = ? AND digest = ?",
      )
      .bind(input.tenantId, input.digest)
      .first<VoucherRow>();
    if (row === null) return { kind: "not_found" };
    const voucher = decodeVoucher(row.value);
    const denied = validateVoucher(voucher, input);
    if (denied !== undefined) return { kind: denied };
    const updated = consumeVoucher(voucher, input.redemption.value);
    const redemption: VoucherRedemption = { ...input.redemption, voucherId: voucher.id };
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE polybill_vouchers SET status = ?, remaining_uses = ?, remaining_amount = ?, remaining_currency = ?, value = ?, update_token = ? WHERE tenant_id = ? AND voucher_id = ? AND status = ? AND remaining_uses = ? AND COALESCE(remaining_amount, '') = COALESCE(?, '') AND NOT EXISTS (SELECT 1 FROM polybill_voucher_redemptions WHERE tenant_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          updated.status,
          updated.remainingUses,
          updated.remainingValue?.amount ?? null,
          updated.remainingValue?.currency ?? null,
          JSON.stringify(updated),
          input.redemption.idempotencyKey,
          input.tenantId,
          voucher.id,
          voucher.status,
          voucher.remainingUses,
          voucher.remainingValue?.amount ?? null,
          input.tenantId,
          input.redemption.idempotencyKey,
        ),
      this.#db
        .prepare(
          `INSERT INTO polybill_voucher_redemptions (tenant_id, redemption_id, voucher_id, idempotency_key, request_hash, value) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM polybill_vouchers WHERE tenant_id = ? AND voucher_id = ? AND update_token = ?)`,
        )
        .bind(
          input.tenantId,
          redemption.id,
          voucher.id,
          redemption.idempotencyKey,
          requestHash,
          JSON.stringify(redemption),
          input.tenantId,
          voucher.id,
          input.redemption.idempotencyKey,
        ),
    ]);
    if (changes(results[0]) === 1 && changes(results[1]) === 1)
      return { kind: "redeemed", voucher: updated, redemption };
    const raced = await this.#redemption(input.tenantId, input.redemption.idempotencyKey);
    return raced === null ? { kind: "conflict" } : this.#redemptionReplay(raced, requestHash);
  }

  async #licenseByIssuance(tenantId: string, issuanceKey: string) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_licenses WHERE tenant_id = ? AND issuance_key = ?",
      )
      .bind(tenantId, issuanceKey)
      .first<{ payload_hash: string; value: string }>();
  }

  async #instance(tenantId: string, licenseId: string, instanceRef: string) {
    return this.#db
      .prepare(
        "SELECT instance_id, tenant_id, license_id, instance_ref, device_digest, activated_at, last_validated_at, deactivated_at FROM polybill_license_instances WHERE tenant_id = ? AND license_id = ? AND instance_ref = ?",
      )
      .bind(tenantId, licenseId, instanceRef)
      .first<LicenseInstanceRow>();
  }

  async #refreshInstance(
    row: LicenseInstanceRow,
    input: Parameters<LicensingStore["activateLicense"]>[0],
  ): Promise<ActivateLicenseResult> {
    if (row.deactivated_at !== null || row.device_digest !== input.instance.deviceDigest)
      return { kind: "conflict" };
    await this.#db
      .prepare(
        "UPDATE polybill_license_instances SET last_validated_at = ? WHERE tenant_id = ? AND license_id = ? AND instance_ref = ? AND deactivated_at IS NULL",
      )
      .bind(input.now, input.tenantId, row.license_id, row.instance_ref)
      .run();
    return {
      kind: "replay",
      instance: decodeLicenseInstance(
        JSON.stringify({
          id: row.instance_id,
          tenantId: row.tenant_id,
          licenseId: row.license_id,
          instanceRef: row.instance_ref,
          deviceDigest: row.device_digest,
          activatedAt: row.activated_at,
          lastValidatedAt: input.now,
        }),
      ),
    };
  }

  async #voucherBatchByIssuance(tenantId: string, issuanceKey: string) {
    return this.#db
      .prepare(
        "SELECT batch_id, payload_hash, value FROM polybill_voucher_batches WHERE tenant_id = ? AND issuance_key = ?",
      )
      .bind(tenantId, issuanceKey)
      .first<{ batch_id: string; payload_hash: string; value: string }>();
  }

  async #voucherReplay(
    row: { batch_id: string; payload_hash: string; value: string },
    payloadHash: string,
  ): Promise<CreateVoucherBatchResult> {
    if (row.payload_hash !== payloadHash) return { kind: "conflict" };
    const result = await this.#db
      .prepare("SELECT value FROM polybill_vouchers WHERE batch_id = ? ORDER BY voucher_id")
      .bind(row.batch_id)
      .all<{ value: string }>();
    return {
      kind: "replay",
      batch: decodeVoucherBatch(row.value),
      vouchers: (result.results ?? []).map((item) => decodeVoucher(item.value)),
    };
  }

  async #redemption(tenantId: string, idempotencyKey: string) {
    return this.#db
      .prepare(
        "SELECT request_hash, value FROM polybill_voucher_redemptions WHERE tenant_id = ? AND idempotency_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ request_hash: string; value: string }>();
  }

  async #redemptionReplay(
    row: { request_hash: string; value: string },
    requestHash: string,
  ): Promise<RedeemVoucherResult> {
    if (row.request_hash !== requestHash) return { kind: "conflict" };
    const redemption = decodeRedemption(row.value);
    const voucher = await this.#db
      .prepare("SELECT value FROM polybill_vouchers WHERE tenant_id = ? AND voucher_id = ?")
      .bind(redemption.tenantId, redemption.voucherId)
      .first<{ value: string }>();
    if (voucher === null) throw new Error("D1 redemption voucher is missing");
    return { kind: "replay", redemption, voucher: decodeVoucher(voucher.value) };
  }
}

interface LicenseInstanceRow {
  readonly instance_id: string;
  readonly tenant_id: string;
  readonly license_id: string;
  readonly instance_ref: string;
  readonly device_digest: string;
  readonly activated_at: string;
  readonly last_validated_at: string;
  readonly deactivated_at: string | null;
}

interface VoucherRow {
  readonly voucher_id: string;
  readonly status: string;
  readonly remaining_uses: number;
  readonly remaining_amount: string | null;
  readonly remaining_currency: string | null;
  readonly expires_at: string | null;
  readonly value: string;
}

function changes(result: D1Result | undefined): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}
