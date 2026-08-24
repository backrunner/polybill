import type {
  EntitlementGrant,
  EntitlementPolicy,
  LicenseInstance,
  LicenseRecord,
  VoucherBatch,
  VoucherRecord,
  VoucherRedemption,
} from "@polybill/licensing";

export function decodeEntitlementPolicy(value: string): EntitlementPolicy {
  const parsed = jsonRecord(value, "entitlement policy");
  requiredStrings(parsed, ["id", "benefit", "revokeOn"]);
  if (
    !["refund", "subscription_end", "never"].includes(String(parsed.revokeOn)) ||
    !nonNegativeInteger(parsed.gracePeriodSeconds)
  )
    throw invalid("entitlement policy");
  return parsed as unknown as EntitlementPolicy;
}

export function decodeEntitlementGrant(value: string): EntitlementGrant {
  const parsed = jsonRecord(value, "entitlement grant");
  requiredStrings(parsed, [
    "id",
    "tenantId",
    "policyId",
    "beneficiaryRef",
    "source",
    "sourceRef",
    "status",
    "grantedAt",
    "updatedAt",
  ]);
  if (
    !["order", "subscription", "manual", "voucher", "migration"].includes(String(parsed.source)) ||
    !["pending", "active", "suspended", "revoked", "expired"].includes(String(parsed.status))
  )
    throw invalid("entitlement grant");
  return parsed as unknown as EntitlementGrant;
}

export function decodeLicense(value: string): LicenseRecord {
  const parsed = jsonRecord(value, "license");
  requiredStrings(parsed, ["id", "tenantId", "digest", "encryptedValue", "grantId", "issuedAt"]);
  if (
    !["active", "suspended", "revoked", "expired"].includes(String(parsed.status)) ||
    !positiveInteger(parsed.activationLimit)
  )
    throw invalid("license");
  return parsed as unknown as LicenseRecord;
}

export function decodeLicenseInstance(value: string): LicenseInstance {
  const parsed = jsonRecord(value, "license instance");
  requiredStrings(parsed, [
    "id",
    "tenantId",
    "licenseId",
    "instanceRef",
    "deviceDigest",
    "activatedAt",
    "lastValidatedAt",
  ]);
  return parsed as unknown as LicenseInstance;
}

export function decodeVoucherBatch(value: string): VoucherBatch {
  const parsed = jsonRecord(value, "voucher batch");
  requiredStrings(parsed, ["id", "tenantId", "prefix", "createdAt"]);
  if (
    !positiveInteger(parsed.quantity) ||
    !positiveInteger(parsed.maxUses) ||
    !record(parsed.benefit)
  )
    throw invalid("voucher batch");
  return parsed as unknown as VoucherBatch;
}

export function decodeVoucher(value: string): VoucherRecord {
  const parsed = jsonRecord(value, "voucher");
  requiredStrings(parsed, ["id", "tenantId", "batchId", "digest", "encryptedValue"]);
  if (
    !["active", "partially_redeemed", "redeemed", "expired", "revoked"].includes(
      String(parsed.status),
    ) ||
    !nonNegativeInteger(parsed.remainingUses)
  )
    throw invalid("voucher");
  return parsed as unknown as VoucherRecord;
}

export function decodeRedemption(value: string): VoucherRedemption {
  const parsed = jsonRecord(value, "voucher redemption");
  requiredStrings(parsed, [
    "id",
    "tenantId",
    "voucherId",
    "idempotencyKey",
    "beneficiaryRef",
    "redeemedAt",
  ]);
  return parsed as unknown as VoucherRedemption;
}

function jsonRecord(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalid(name);
  }
  if (!record(parsed)) throw invalid(name);
  return parsed;
}

function requiredStrings(value: Record<string, unknown>, keys: readonly string[]): void {
  if (keys.some((key) => typeof value[key] !== "string")) throw invalid("record");
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(name: string): TypeError {
  return new TypeError(`Stored D1 ${name} is invalid`);
}
