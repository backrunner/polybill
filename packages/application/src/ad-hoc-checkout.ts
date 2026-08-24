import type {
  ProviderCheckoutCommand,
  ProviderCheckoutSnapshot,
  ProviderContext,
  ProviderOperationResult,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  addMoney,
  checkCommercialPolicy,
  money,
  multiplyMoney,
  parseId,
  parseIsoDateTime,
  transitionPayment,
  type CustomerId,
  type IdempotencyKey,
  type Money,
  type Order,
  type PriceModel,
} from "@polybill/core";
import {
  fixedUnitAmount,
  invalidCheckout,
  parseStoredCheckoutResult,
  parseStoredPreparedCheckout,
  stableStringify,
  validatedRedirectUrl,
  type StoredPreparedCheckout,
} from "./checkout-helpers.js";
import type { CheckoutServiceOptions, CreateCheckoutResult } from "./checkout.js";
import type { IdempotencyScope } from "./ports.js";

export interface CreateAdHocCheckoutItem {
  readonly skuId: ProviderCheckoutCommand["lines"][number]["skuId"];
  readonly price: PriceModel;
  readonly unitAmount?: Money;
  readonly quantity: number;
  readonly persistence: "session" | "reusable";
}

export interface CreateAdHocCheckoutCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly customerId?: CustomerId;
  readonly customerEmail?: string;
  readonly items: readonly CreateAdHocCheckoutItem[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class AdHocCheckoutService {
  readonly #options: CheckoutServiceOptions;

  constructor(options: CheckoutServiceOptions) {
    this.#options = options;
  }

  async create(command: CreateAdHocCheckoutCommand): Promise<CreateCheckoutResult> {
    assertInput(command);
    const context = await this.#context(command.idempotencyKey);
    await this.#assertCapability(context, command.items.length);
    const scope: IdempotencyScope = {
      tenantId: this.#options.tenantId,
      connectionId: this.#options.connection.id,
      operation: "checkout.create_ad_hoc",
      key: command.idempotencyKey,
    };
    const claim = await this.#options.store.claim(
      scope,
      await this.#options.crypto.sha256(new TextEncoder().encode(stableStringify(command))),
    );
    if (claim.kind === "replay") return parseStoredCheckoutResult(claim.result);
    if (claim.kind === "conflict" || claim.kind === "in_progress")
      throw commandError(
        claim.kind === "conflict" ? "idempotency_conflict" : "conflict",
        this.#options,
      );

    try {
      const checkout = this.#options.adapter.checkout;
      if (checkout === undefined) throw unsupported(this.#options);
      if (claim.kind === "outcome_unknown") {
        if (checkout.recoverByIdempotencyKey === undefined)
          throw commandError("outcome_unknown", this.#options);
        const prepared = parseStoredPreparedCheckout(claim.recoveryContext);
        const recovered = await checkout.recoverByIdempotencyKey(
          context,
          command.idempotencyKey,
          prepared.providerCommand,
        );
        if (recovered === undefined) throw commandError("outcome_unknown", this.#options);
        return this.#commit(scope, claim.leaseToken, prepared, recovered);
      }
      const prepared = prepare(command, this.#options);
      await this.#options.store.saveRecoveryContext(scope, claim.leaseToken, prepared);
      const remote = await checkout.create(context, prepared.providerCommand);
      return this.#commit(scope, claim.leaseToken, prepared, remote);
    } catch (error) {
      if (error instanceof PolybillError && error.code === "outcome_unknown")
        await this.#options.store.markUnknown(scope, claim.leaseToken, error.evidenceRef);
      else await this.#options.store.release(scope, claim.leaseToken);
      throw error;
    }
  }

  async #assertCapability(context: ProviderContext, itemCount: number): Promise<void> {
    const snapshot = await this.#options.adapter.getCapabilities(context);
    for (const key of ["checkout.hosted", "checkout.ad_hoc_price"] as const) {
      const capability = snapshot.capabilities[key];
      if (
        (capability?.support !== "native" && capability?.support !== "emulated") ||
        !capability.environments.includes(this.#options.connection.environment)
      )
        throw unsupported(this.#options, `Provider does not support ${key}`);
    }
    if (itemCount > 1) {
      const multi = snapshot.capabilities["checkout.multi_item"];
      if (multi?.support !== "native" && multi?.support !== "emulated")
        throw unsupported(this.#options, "Provider does not support multi-item checkout");
    }
    const violations = checkCommercialPolicy(
      this.#options.commercialPolicy ?? {},
      snapshot.commercialTerms,
    );
    if (violations.length > 0)
      throw new PolybillError(`Commercial policy is incompatible: ${violations.join(", ")}`, {
        code: "commercial_policy_incompatible",
        operation: "checkout.create_ad_hoc",
        provider: this.#options.connection.provider,
        connectionId: this.#options.connection.id,
        retryable: false,
      });
  }

  async #context(idempotencyKey: IdempotencyKey): Promise<ProviderContext> {
    const now = this.#options.clock.now();
    return {
      tenantId: this.#options.tenantId,
      connection: this.#options.connection,
      credentials:
        typeof this.#options.credentials === "function"
          ? await this.#options.credentials()
          : this.#options.credentials,
      requestId: parseId<"RequestId">(this.#options.ids.next("req"), "req"),
      idempotencyKey,
      deadline: parseIsoDateTime(
        new Date(Date.parse(now) + (this.#options.timeoutMs ?? 10_000)).toISOString(),
      ),
      fetch: this.#options.fetch,
      crypto: this.#options.crypto,
      clock: this.#options.clock,
    };
  }

  async #commit(
    scope: IdempotencyScope,
    leaseToken: string,
    prepared: StoredPreparedCheckout,
    remote: ProviderOperationResult<ProviderCheckoutSnapshot>,
  ): Promise<CreateCheckoutResult> {
    const now = this.#options.clock.now();
    const order: Order = {
      id: prepared.orderId,
      lines: prepared.lines.map((line) => ({
        skuId: line.skuId,
        price: line.price,
        quantity: line.quantity,
        subtotal: multiplyMoney(line.unitAmount, line.quantity),
      })),
      total: prepared.providerCommand.total,
      paymentStatus: "pending",
      fulfillmentStatus: "unfulfilled",
      commercialTermsRef: parseId<"EvidenceId">(this.#options.ids.next("evi"), "evi"),
      createdAt: now,
    };
    const pending = {
      id: prepared.paymentId,
      orderId: prepared.orderId,
      status: "pending" as const,
      amount: order.total,
      refundedAmount: money("0", order.total.currency),
      evidence: [],
    };
    const result: CreateCheckoutResult = {
      checkout: {
        id: prepared.checkoutId,
        orderId: prepared.orderId,
        status: remote.value.status === "complete" ? "complete" : "open",
        ...(remote.value.url === undefined ? {} : { url: remote.value.url }),
        ...(remote.value.expiresAt === undefined ? {} : { expiresAt: remote.value.expiresAt }),
      },
      order,
      payment:
        remote.value.status === "complete" ? transitionPayment(pending, "succeeded") : pending,
      provider: this.#options.connection.provider,
      warnings: remote.warnings,
    };
    await this.#options.store.commitCheckout({
      tenantId: this.#options.tenantId,
      connectionId: this.#options.connection.id,
      provider: this.#options.connection.provider,
      externalCheckoutId: remote.value.externalId,
      checkout: result.checkout,
      order,
      payment: result.payment,
      evidenceId: parseId<"EvidenceId">(this.#options.ids.next("evi"), "evi"),
      evidence: remote.evidence,
      occurredAt: now,
    });
    await this.#options.store.complete(scope, leaseToken, result);
    return result;
  }
}

function prepare(
  command: CreateAdHocCheckoutCommand,
  options: CheckoutServiceOptions,
): StoredPreparedCheckout {
  const lines = command.items.map((item) => ({
    skuId: item.skuId,
    quantity: item.quantity,
    price: item.price,
    unitAmount: unitAmount(item.price, item.unitAmount),
  }));
  const total = lines.reduce<Money | undefined>((sum, line) => {
    const subtotal = multiplyMoney(line.unitAmount, line.quantity);
    return sum === undefined ? subtotal : addMoney(sum, subtotal);
  }, undefined);
  if (total === undefined) throw invalidCheckout("Checkout must include at least one line item");
  const orderId = parseId<"OrderId">(options.ids.next("ord"), "ord");
  return {
    orderId,
    checkoutId: parseId<"CheckoutId">(options.ids.next("chk"), "chk"),
    paymentId: parseId<"PaymentId">(options.ids.next("pay"), "pay"),
    lines,
    providerCommand: {
      orderId,
      ...(command.customerId === undefined ? {} : { customerId: command.customerId }),
      ...(command.customerEmail === undefined ? {} : { customerEmail: command.customerEmail }),
      lines,
      total,
      successUrl: validatedRedirectUrl(command.successUrl),
      cancelUrl: validatedRedirectUrl(command.cancelUrl),
      metadata: command.metadata ?? {},
    },
  };
}

function assertInput(command: CreateAdHocCheckoutCommand): void {
  if (command.items.length === 0 || command.items.some((item) => item.quantity < 1))
    throw invalidCheckout("Checkout quantities must be positive");
  if (command.items.some((item) => item.persistence !== "session"))
    throw invalidCheckout("Reusable ad hoc prices must be created through the catalog service");
  validatedRedirectUrl(command.successUrl);
  validatedRedirectUrl(command.cancelUrl);
}

function unitAmount(price: PriceModel, explicit: Money | undefined): Money {
  if (price.kind !== "custom") {
    if (explicit !== undefined)
      throw invalidCheckout("An explicit unit amount is only valid for a custom price");
    return fixedUnitAmount(price);
  }
  if (explicit === undefined) throw invalidCheckout("A custom price requires an explicit amount");
  if (price.minimum !== undefined) {
    if (explicit.currency !== price.minimum.currency)
      throw invalidCheckout("The custom price currency does not match its minimum");
    if (BigInt(explicit.amount) < BigInt(price.minimum.amount))
      throw invalidCheckout("The custom price is below its minimum");
  }
  return explicit;
}

function unsupported(options: CheckoutServiceOptions, message = "Hosted checkout is unsupported") {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "checkout.create_ad_hoc",
    provider: options.connection.provider,
    connectionId: options.connection.id,
    retryable: false,
  });
}

function commandError(
  code: "idempotency_conflict" | "conflict" | "outcome_unknown",
  options: CheckoutServiceOptions,
) {
  return new PolybillError(`Ad hoc checkout command failed: ${code}`, {
    code,
    operation: "checkout.create_ad_hoc",
    provider: options.connection.provider,
    connectionId: options.connection.id,
    retryable: code !== "idempotency_conflict",
  });
}
