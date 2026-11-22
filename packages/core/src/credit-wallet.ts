import type { CreditTransactionId, CustomerId } from "./ids.js";
import type { IsoDateTime } from "./time.js";

export interface CreditWalletKey {
  readonly customerId: CustomerId;
  readonly name: string;
}

export interface CreditWallet extends CreditWalletKey {
  readonly unit: string;
  readonly status: "active" | "frozen" | "closed";
}

export interface CreditWalletTransaction extends CreditWalletKey {
  readonly id: CreditTransactionId;
  readonly kind: "grant" | "debit" | "reversal";
  readonly amount: string;
  readonly reference: string;
  readonly occurredAt: IsoDateTime;
  readonly reversalOf?: CreditTransactionId;
}

export function parseCreditAmount(value: unknown, allowZero = false): string {
  if (allowZero && value === "0") return value;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value))
    throw new TypeError("Credit amount must be a positive decimal integer string");
  return value;
}
