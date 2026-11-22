import {
  arrayField,
  invalid,
  object,
  providerIdempotencyKey,
  stringField,
  type CreditWalletProvider,
  type JsonObject,
  type ProviderContext,
  type ProviderCreditAccount,
  type ProviderCreditAdjustment,
  type ProviderCreditTransaction,
} from "@polybill/adapter-kit";
import { parseCreditAmount, parseIsoDateTime, PolybillError } from "@polybill/core";
import { creemRequest } from "./client.js";

const ledger = "/v1/customer-credits";
const accounts = `${ledger}/accounts`;
const operation = "creem.credit_wallet.decode";

export const creemCreditWallets: CreditWalletProvider = {
  findAccount,
  async createAccount(context, externalCustomerId, name, unit) {
    let value: unknown;
    try {
      value = (
        await creemRequest(context, "POST", accounts, {
          customer_id: externalCustomerId,
          name,
          unit_label: unit,
        })
      ).json();
    } catch (error) {
      if (error instanceof PolybillError && error.code === "conflict") {
        const existing = await findAccount(context, externalCustomerId, name);
        if (existing !== undefined) return existing;
      }
      throw error;
    }
    const created = decodeAccount(value, externalCustomerId);
    if (created.name !== name || created.unit !== unit) throw invalid("creem", operation);
    return created;
  },
  async getBalance(context, account) {
    const response = await creemRequest(context, "GET", `${accountPath(account)}/balance`);
    return amount(object(response.json(), "creem", operation).balance, true);
  },
  async adjust(context, account, adjustment) {
    const { path, key, expected } = await adjustmentRequest(context, account, adjustment);
    const response = await creemRequest(context, "POST", path, {
      amount: adjustment.amount,
      reference: adjustment.reference,
      idempotency_key: key,
      ...(adjustment.moderationId === undefined ? {} : { moderation_id: adjustment.moderationId }),
    });
    return decodeTransaction(response.json(), account, expected);
  },
  async recoverAdjustment(context, account, adjustment) {
    const { key, expected } = await adjustmentRequest(context, account, adjustment);
    const query = new URLSearchParams({ reference: adjustment.reference });
    const response = await creemRequest(context, "GET", `${ledger}/transactions?${query}`);
    const payload = object(response.json(), "creem", operation);
    if (payload.object !== "list" || typeof payload.has_more !== "boolean")
      throw invalid("creem", operation);
    const matching = arrayField(payload, "data", "creem", operation)
      .map((entry) => object(entry, "creem", operation))
      .filter((entry) => stringField(entry, "idempotency_key", "creem", operation) === key);
    if (matching.length > 1) throw invalid("creem", operation);
    return matching[0] === undefined
      ? undefined
      : decodeTransaction(matching[0], account, expected);
  },
  async reverse(context, account, externalId, original) {
    const response = await creemRequest(context, "POST", `${accountPath(account)}/reverse`, {
      transaction_id: externalId,
    });
    return decodeTransaction(response.json(), account, {
      amount: original.amount,
      side: original.kind === "debit" ? "credit" : "debit",
      reversalOf: externalId,
    });
  },
};

async function findAccount(context: ProviderContext, customer: string, name: string) {
  const query = new URLSearchParams({ customer_id: customer, limit: "100" });
  const seen = new Set<string>();
  while (true) {
    const response = await creemRequest(context, "GET", `${accounts}?${query}`);
    const payload = object(response.json(), "creem", operation);
    if (payload.object !== "list" || typeof payload.has_more !== "boolean")
      throw invalid("creem", operation);
    const page = arrayField(payload, "data", "creem", operation).map((value) =>
      decodeAccount(value, customer),
    );
    const matching = page.filter((account) => account.name === name);
    if (matching.length > 1) throw invalid("creem", operation);
    if (matching[0] !== undefined || !payload.has_more) return matching[0];
    const cursor = page.at(-1)?.externalId;
    if (cursor === undefined || seen.has(cursor)) throw invalid("creem", operation);
    seen.add(cursor);
    query.set("starting_after", cursor);
  }
}

function decodeAccount(payload: unknown, customer: string): ProviderCreditAccount {
  const value = object(payload, "creem", operation);
  const status = value.status;
  const name = stringField(value, "name", "creem", operation).trim().toLowerCase();
  const unit = stringField(value, "unit_label", "creem", operation);
  if (
    (status !== "active" && status !== "frozen" && status !== "closed") ||
    value.customer_id !== customer ||
    name.length === 0 ||
    unit.trim().length === 0
  )
    throw invalid("creem", operation);
  return { externalId: ledgerId(value, "cca_"), externalCustomerId: customer, name, unit, status };
}

interface ExpectedTransaction {
  readonly amount: string;
  readonly side: "credit" | "debit";
  readonly adjustment?: ProviderCreditAdjustment & { readonly key: string };
  readonly reversalOf?: string;
}

async function adjustmentRequest(
  context: ProviderContext,
  account: ProviderCreditAccount,
  adjustment: ProviderCreditAdjustment,
) {
  const side = adjustment.kind === "grant" ? "credit" : "debit";
  const path = `${accountPath(account)}/${side}`;
  const key = await providerIdempotencyKey(context, "POST", path);
  if (key === undefined)
    throw new PolybillError("Credit adjustments require an idempotency key", {
      code: "invalid_request",
      operation: "creem.credit_wallet.adjust",
      provider: "creem",
      connectionId: context.connection.id,
      retryable: false,
    });
  const expected: ExpectedTransaction = {
    amount: adjustment.amount,
    side,
    adjustment: { ...adjustment, key },
  };
  return { path, key, expected };
}

function decodeTransaction(
  payload: unknown,
  account: ProviderCreditAccount,
  expected: ExpectedTransaction,
): ProviderCreditTransaction {
  const value = object(payload, "creem", operation);
  const externalId = ledgerId(value, "cct_");
  const reference = stringField(value, "reference", "creem", operation);
  const entries = arrayField(value, "entries", "creem", operation);
  if (
    (value.reversal_of ?? undefined) !== expected.reversalOf ||
    (expected.adjustment !== undefined &&
      (reference !== expected.adjustment.reference ||
        value.idempotency_key !== expected.adjustment.key ||
        (value.moderation_id ?? undefined) !== expected.adjustment.moderationId))
  )
    throw invalid("creem", operation);
  // A debit can be split across credit lots. All entries must be on the requested side and account.
  let total = 0n;
  for (const entry of entries) {
    const record = object(entry, "creem", operation);
    if (
      record.transaction_id !== externalId ||
      record.account_id !== account.externalId ||
      record.side !== expected.side
    )
      throw invalid("creem", operation);
    total += BigInt(amount(record.amount));
  }
  if (String(total) !== expected.amount) throw invalid("creem", operation);
  try {
    return {
      externalId,
      reference,
      amount: expected.amount,
      occurredAt: parseIsoDateTime(value.created_at),
    };
  } catch {
    throw invalid("creem", operation);
  }
}

function ledgerId(value: JsonObject, prefix: "cca_" | "cct_") {
  const id = stringField(value, "id", "creem", operation);
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]{5,128}$/u.test(id))
    throw invalid("creem", operation);
  return id;
}

function amount(value: unknown, allowZero = false) {
  try {
    return parseCreditAmount(value, allowZero);
  } catch {
    throw invalid("creem", operation);
  }
}

function accountPath(account: ProviderCreditAccount) {
  return `${accounts}/${encodeURIComponent(account.externalId)}`;
}
