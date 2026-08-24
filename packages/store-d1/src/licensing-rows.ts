import type { D1Result } from "./d1.js";

export interface LicenseInstanceRow {
  readonly instance_id: string;
  readonly tenant_id: string;
  readonly license_id: string;
  readonly instance_ref: string;
  readonly device_digest: string;
  readonly activated_at: string;
  readonly last_validated_at: string;
  readonly deactivated_at: string | null;
}

export interface VoucherRow {
  readonly voucher_id: string;
  readonly status: string;
  readonly remaining_uses: number;
  readonly remaining_amount: string | null;
  readonly remaining_currency: string | null;
  readonly expires_at: string | null;
  readonly value: string;
}

export function changes(result: D1Result | undefined): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}
