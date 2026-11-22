import type { CreditWallet, IsoDateTime } from "@polybill/core";
import type { ProviderContext } from "./context.js";

export interface ProviderCreditAccount {
  readonly externalId: string;
  readonly externalCustomerId: string;
  readonly name: string;
  readonly unit: string;
  readonly status: CreditWallet["status"];
}

export interface ProviderCreditAdjustment {
  readonly kind: "grant" | "debit";
  readonly amount: string;
  readonly reference: string;
  readonly moderationId?: string;
}

export interface ProviderCreditTransaction {
  readonly externalId: string;
  readonly amount: string;
  readonly reference: string;
  readonly occurredAt: IsoDateTime;
}

/** Route mutations through context.fetch so the application can record dispatch durably. */
export interface CreditWalletProvider {
  findAccount(
    context: ProviderContext,
    externalCustomerId: string,
    name: string,
  ): Promise<ProviderCreditAccount | undefined>;
  createAccount(
    context: ProviderContext,
    externalCustomerId: string,
    name: string,
    unit: string,
  ): Promise<ProviderCreditAccount>;
  getBalance(context: ProviderContext, account: ProviderCreditAccount): Promise<string>;
  adjust(
    context: ProviderContext,
    account: ProviderCreditAccount,
    adjustment: ProviderCreditAdjustment,
  ): Promise<ProviderCreditTransaction>;
  /** Read back the exact adjustment without replaying a mutation. */
  recoverAdjustment(
    context: ProviderContext,
    account: ProviderCreditAccount,
    adjustment: ProviderCreditAdjustment,
  ): Promise<ProviderCreditTransaction | undefined>;
  /** Repeated reversals of the same original transaction must return the same result. */
  reverse(
    context: ProviderContext,
    account: ProviderCreditAccount,
    externalId: string,
    original: { readonly amount: string; readonly kind: "grant" | "debit" },
  ): Promise<ProviderCreditTransaction>;
}
