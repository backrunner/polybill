import {
  type CapabilityKey,
  type CreditWalletProvider,
  type ModerationReceipt,
  type ProviderContext,
  type ProviderCreditAccount,
  type ProviderCreditAdjustment,
  type ProviderCreditTransaction,
} from "@polybill/adapter-kit";
import {
  parseCreditAmount,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  PolybillError,
  type CreditTransactionId,
  type CreditWallet,
  type CreditWalletKey,
  type CreditWalletTransaction,
  type IdempotencyKey,
} from "@polybill/core";
import { requireExternalId, type ResourceRuntime } from "./resource-runtime.js";

export interface CreditWalletAdjustment extends CreditWalletKey {
  readonly amount: string;
  readonly reference: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface DebitCreditWalletCommand extends CreditWalletAdjustment {
  readonly moderation?: ModerationReceipt;
}

const entity = "credit_wallet_transaction";

export class CreditWalletService {
  constructor(private readonly runtime: ResourceRuntime) {}

  async get(input: CreditWalletKey): Promise<CreditWallet | undefined> {
    const wallet = walletKey(input);
    const context = await this.runtime.context();
    const port = await this.#port(context, "credit_wallet.read");
    const account = await this.#find(context, port, wallet);
    return account === undefined ? undefined : asWallet(wallet, account);
  }

  async ensure(
    input: CreditWalletKey & { readonly unit: string; readonly idempotencyKey: IdempotencyKey },
  ): Promise<CreditWallet> {
    const operation = "credit_wallet.create";
    const wallet = walletKey(input);
    const unit = label(input.unit, "unit");
    const getOrCreate = async (context: ProviderContext, create: boolean) => {
      const port = await this.#port(context, operation);
      const customer = await this.#externalId(context, "customer", wallet.customerId, operation);
      const existing = await port.findAccount(context, customer, wallet.name);
      const account =
        existing ??
        (create ? await port.createAccount(context, customer, wallet.name, unit) : undefined);
      if (account === undefined) return undefined;
      if (account.unit !== unit) throw this.#error("conflict", operation, "Wallet unit differs");
      return asWallet(wallet, account);
    };
    return this.runtime.mutate({
      operation,
      key: parseIdempotencyKey(input.idempotencyKey),
      payload: { ...wallet, unit },
      tracksMutationsThroughFetch: true,
      decodeReplay: decodeWallet,
      async execute(context) {
        const result = await getOrCreate(context, true);
        if (result === undefined) throw new Error("Provider did not create the wallet");
        return result;
      },
      recover: (context) => getOrCreate(context, false),
    });
  }

  async balance(input: CreditWalletKey): Promise<string> {
    const wallet = walletKey(input);
    const context = await this.runtime.context();
    const port = await this.#port(context, "credit_wallet.read");
    return port.getBalance(context, await this.#account(context, port, wallet));
  }

  grant(input: CreditWalletAdjustment): Promise<CreditWalletTransaction> {
    return this.#adjust(input, "grant");
  }

  debit(input: DebitCreditWalletCommand): Promise<CreditWalletTransaction> {
    return this.#adjust(input, "debit", input.moderation);
  }

  async reverse(input: {
    readonly transactionId: CreditTransactionId;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<CreditWalletTransaction> {
    const operation = "credit_wallet.reverse";
    const transactionId = parseId<"CreditTransactionId">(input.transactionId, "ctx");
    const execute = async (context: ProviderContext) => {
      const port = await this.#port(context, operation);
      const externalId = await this.#externalId(context, entity, transactionId, operation);
      const stored = await this.runtime.options.store.getResource(
        context.tenantId,
        entity,
        transactionId,
      );
      const original = decodeTransaction(stored);
      if (original.kind === "reversal")
        throw this.#error("invalid_request", operation, "A credit reversal cannot be reversed");
      const account = await this.#account(context, port, original);
      const remote = await port.reverse(context, account, externalId, {
        kind: original.kind,
        amount: original.amount,
      });
      return this.#save(
        context,
        original,
        "reversal",
        { ...remote, reference: original.reference },
        transactionId,
      );
    };
    return this.runtime.mutate({
      operation,
      key: parseIdempotencyKey(input.idempotencyKey),
      payload: { transactionId },
      tracksMutationsThroughFetch: true,
      decodeReplay: decodeTransaction,
      execute,
      // The upstream reversal always returns the reversal of this exact transaction.
      recover: execute,
    });
  }

  async #adjust(
    input: CreditWalletAdjustment,
    kind: ProviderCreditAdjustment["kind"],
    receipt?: ModerationReceipt,
  ): Promise<CreditWalletTransaction> {
    const operation = kind === "grant" ? "credit_wallet.grant" : "credit_wallet.debit";
    const wallet = walletKey(input);
    if (kind === "debit" && wallet.name === "generation" && receipt === undefined)
      throw this.#error("invalid_request", operation, "Generation debits require moderation");
    const reference = label(input.reference, "reference");
    const moderationId = receipt === undefined ? undefined : this.#moderationId(receipt, reference);
    const adjustment: ProviderCreditAdjustment = {
      kind,
      amount: parseCreditAmount(input.amount),
      reference,
      ...(moderationId === undefined ? {} : { moderationId }),
    };
    const adjust = async (context: ProviderContext, recover: boolean) => {
      const port = await this.#port(context, operation);
      const account = await this.#account(context, port, wallet);
      const remote = recover
        ? await port.recoverAdjustment(context, account, adjustment)
        : await port.adjust(context, account, adjustment);
      return remote === undefined ? undefined : this.#save(context, wallet, kind, remote);
    };
    return this.runtime.mutate({
      operation,
      key: parseIdempotencyKey(input.idempotencyKey),
      payload: { ...wallet, ...adjustment },
      tracksMutationsThroughFetch: true,
      decodeReplay: decodeTransaction,
      async execute(context) {
        const result = await adjust(context, false);
        if (result === undefined) throw new Error("Provider did not return the credit transaction");
        return result;
      },
      recover: (context) => adjust(context, true),
    });
  }

  #moderationId(receipt: ModerationReceipt, reference: string): string {
    const { connection } = this.runtime.options;
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      receipt.connection?.id !== connection.id ||
      receipt.connection.tenantId !== connection.tenantId ||
      receipt.connection.environment !== connection.environment ||
      receipt.connection.provider !== connection.provider ||
      receipt.connection.accountRef !== connection.accountRef ||
      (receipt.reference !== undefined && receipt.reference !== reference) ||
      typeof receipt.providerResultId !== "string" ||
      receipt.providerResultId.length === 0 ||
      receipt.providerResultId.length > 64
    )
      throw this.#error(
        "invalid_request",
        "credit_wallet.debit",
        "Invalid moderation receipt for this connection",
      );
    return receipt.providerResultId;
  }

  async #port(context: ProviderContext, operation: CapabilityKey): Promise<CreditWalletProvider> {
    await this.runtime.requireCapability(operation, context);
    const port = this.runtime.options.adapter.creditWallets;
    if (port === undefined)
      throw this.#error(
        "unsupported_capability",
        operation,
        "Provider does not expose credit wallets",
      );
    return port;
  }

  #externalId(
    context: ProviderContext,
    type: string,
    id: string,
    operation: string,
  ): Promise<string> {
    return this.runtime.options.store
      .getExternalId(context.tenantId, context.connection.id, type, id)
      .then((externalId) => requireExternalId(externalId, operation));
  }

  async #find(context: ProviderContext, port: CreditWalletProvider, wallet: CreditWalletKey) {
    const customer = await this.#externalId(
      context,
      "customer",
      wallet.customerId,
      "credit_wallet.read",
    );
    return port.findAccount(context, customer, wallet.name);
  }

  async #account(context: ProviderContext, port: CreditWalletProvider, wallet: CreditWalletKey) {
    const account = await this.#find(context, port, wallet);
    if (account === undefined)
      throw this.#error("not_found", "credit_wallet.read", "Wallet was not found");
    return account;
  }

  async #save(
    context: ProviderContext,
    wallet: CreditWalletKey,
    kind: CreditWalletTransaction["kind"],
    remote: ProviderCreditTransaction,
    reversalOf?: CreditTransactionId,
  ): Promise<CreditWalletTransaction> {
    const digest = await context.crypto.sha256(
      new TextEncoder().encode(
        JSON.stringify([
          context.tenantId,
          context.connection.id,
          context.connection.environment,
          remote.externalId,
        ]),
      ),
    );
    const value: CreditWalletTransaction = {
      customerId: wallet.customerId,
      name: wallet.name,
      id: parseId<"CreditTransactionId">(`ctx_${digest}`, "ctx"),
      kind,
      amount: remote.amount,
      reference: remote.reference,
      occurredAt: remote.occurredAt,
      ...(reversalOf === undefined ? {} : { reversalOf }),
    };
    await this.runtime.options.store.insertResource({
      tenantId: context.tenantId,
      connectionId: context.connection.id,
      provider: context.connection.provider,
      entityType: entity,
      entityId: value.id,
      externalId: remote.externalId,
      value,
      occurredAt: value.occurredAt,
    });
    return value;
  }

  #error(
    code: "invalid_request" | "unsupported_capability" | "conflict" | "not_found",
    operation: string,
    message: string,
  ) {
    const { connection } = this.runtime.options;
    return new PolybillError(message, {
      code,
      operation,
      provider: connection.provider,
      connectionId: connection.id,
      retryable: false,
    });
  }
}

function walletKey(input: CreditWalletKey): CreditWalletKey {
  return {
    customerId: parseId<"CustomerId">(input.customerId, "cust"),
    name: label(label(input.name, "name").trim().toLowerCase(), "name", 100),
  };
}

function label(value: unknown, field: string, limit?: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    (limit !== undefined && value.length > limit) ||
    /\p{Cc}/u.test(value)
  )
    throw new TypeError(`Invalid credit wallet ${field}`);
  return value;
}

function asWallet(key: CreditWalletKey, account: ProviderCreditAccount): CreditWallet {
  return { ...key, unit: account.unit, status: account.status };
}

function decodeWallet(value: unknown): CreditWallet {
  const root = storedRecord(value);
  const { status } = root;
  if (status !== "active" && status !== "frozen" && status !== "closed")
    throw new TypeError("Invalid stored wallet status");
  return {
    customerId: parseId<"CustomerId">(root.customerId, "cust"),
    name: label(root.name, "name"),
    unit: label(root.unit, "unit"),
    status,
  };
}

function decodeTransaction(value: unknown): CreditWalletTransaction {
  const root = storedRecord(value);
  const { kind } = root;
  if (kind !== "grant" && kind !== "debit" && kind !== "reversal")
    throw new TypeError("Invalid stored credit transaction kind");
  return {
    id: parseId<"CreditTransactionId">(root.id, "ctx"),
    customerId: parseId<"CustomerId">(root.customerId, "cust"),
    name: label(root.name, "name"),
    kind,
    amount: parseCreditAmount(root.amount),
    reference: label(root.reference, "reference"),
    occurredAt: parseIsoDateTime(root.occurredAt),
    ...(root.reversalOf === undefined
      ? {}
      : {
          reversalOf: parseId<"CreditTransactionId">(root.reversalOf, "ctx"),
        }),
  };
}

function storedRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid stored credit wallet record");
  return value as Record<string, unknown>;
}
