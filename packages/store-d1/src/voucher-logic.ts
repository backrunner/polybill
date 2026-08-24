import { compareMoney, subtractMoney } from "@polybill/core";
import type { LicensingStore, VoucherRecord, VoucherRedemption } from "@polybill/licensing";

export type VoucherDenial =
  "inactive" | "expired" | "exhausted" | "insufficient_value" | "conflict";

export function validateVoucher(
  voucher: VoucherRecord,
  input: Parameters<LicensingStore["redeemVoucher"]>[0],
): VoucherDenial | undefined {
  if (
    voucher.status === "expired" ||
    (voucher.expiresAt !== undefined && Date.parse(voucher.expiresAt) <= Date.parse(input.now))
  )
    return "expired";
  if (voucher.status === "revoked") return "inactive";
  if (voucher.remainingUses < 1 || voucher.status === "redeemed") return "exhausted";
  if (voucher.remainingValue === undefined)
    return input.redemption.value === undefined ? undefined : "conflict";
  const value = input.redemption.value;
  if (value === undefined || value.amount === "0") return "conflict";
  try {
    return compareMoney(value, voucher.remainingValue) > 0 ? "insufficient_value" : undefined;
  } catch {
    return "conflict";
  }
}

export function consumeVoucher(
  voucher: VoucherRecord,
  value: VoucherRedemption["value"],
): VoucherRecord {
  if (voucher.remainingValue !== undefined && value === undefined)
    throw new TypeError("A credit voucher redemption requires a value");
  const remainingValue =
    voucher.remainingValue === undefined || value === undefined
      ? undefined
      : subtractMoney(voucher.remainingValue, value);
  const remainingUses = voucher.remainingUses - 1;
  const exhausted = remainingUses === 0 || remainingValue?.amount === "0";
  return {
    ...voucher,
    remainingUses,
    ...(remainingValue === undefined ? {} : { remainingValue }),
    status: exhausted ? "redeemed" : "partially_redeemed",
  };
}
