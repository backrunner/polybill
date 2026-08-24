import type {
  CryptoPort,
  CredentialResolver,
  ProviderAdapter,
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
  type CheckoutId,
  type CheckoutSession,
  type CommercialPolicy,
  type ConnectionRef,
  type CustomerId,
  type IdempotencyKey,
  type IsoDateTime,
  type Money,
  type Order,
  type OrderId,
  type Payment,
  type PaymentId,
  type TenantId,
} from "@polybill/core";
import {
  fixedUnitAmount,
  invalidCheckout,
  parseStoredCheckoutResult,
  parseStoredPreparedCheckout,
  stableStringify,
  validatedRedirectUrl,
} from "./checkout-helpers.js";
import type { ApplicationStore, IdGenerator, Logger } from "./ports.js";

export interface CreateCheckoutItem {
  readonly priceId: string;
  readonly quantity: number;
}

export interface CreateCheckoutCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly customerId?: CustomerId;
  readonly customerEmail?: string;
  readonly items: readonly CreateCheckoutItem[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateCheckoutResult {
  readonly checkout: CheckoutSession;
  readonly order: Order;
  readonly payment: Payment;
  readonly provider: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface CheckoutServiceOptions {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly credentials: ProviderContext["credentials"] | CredentialResolver;
  readonly adapter: ProviderAdapter;
  readonly store: ApplicationStore;
  readonly crypto: CryptoPort;
  readonly clock: ProviderContext["clock"];
  readonly ids: IdGenerator;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: Logger;
  readonly commercialPolicy?: CommercialPolicy;
  readonly timeoutMs?: number;
}

export class CheckoutService {
  readonly #options: CheckoutServiceOptions;

  constructor(options: CheckoutServiceOptions) {
    if (options.connection.tenantId !== options.tenantId) {
      throw new PolybillError("Connection does not belong to the requested tenant", {
        code: "invalid_request",
        operation: "checkout.initialize",
        retryable: false,
      });
    }
    this.#options = options;
  }

  async create(command: CreateCheckoutCommand): Promise<CreateCheckoutResult> {
    assertCheckoutInput(command);
    validatedRedirectUrl(command.successUrl);
    validatedRedirectUrl(command.cancelUrl);
    const context = await this.#context(command.idempotencyKey);
    const capabilities = await this.#options.adapter.getCapabilities(context);
    this.#assertAvailable(capabilities, command.items.length);

    const scope = {
      tenantId: this.#options.tenantId,
      connectionId: this.#options.connection.id,
      operation: "checkout.create",
      key: command.idempotencyKey,
    } as const;
    const payloadHash = await this.#hash(command);
    const claim = await this.#options.store.claim(scope, payloadHash);
    if (claim.kind === "replay") return parseStoredCheckoutResult(claim.result);
    if (claim.kind === "conflict") {
      throw new PolybillError("Idempotency key was already used with a different payload", {
        code: "idempotency_conflict",
        operation: "checkout.create",
        provider: this.#options.connection.provider,
        connectionId: this.#options.connection.id,
        retryable: false,
      });
    }
    if (claim.kind === "in_progress") {
      throw new PolybillError("The same checkout command is already in progress", {
        code: "conflict",
        operation: "checkout.create",
        provider: this.#options.connection.provider,
        connectionId: this.#options.connection.id,
        retryable: true,
      });
    }

    try {
      const checkoutPort = this.#options.adapter.checkout;
      if (checkoutPort === undefined) throw unsupported(this.#options.connection);
      if (claim.kind === "outcome_unknown") {
        if (checkoutPort.recoverByIdempotencyKey === undefined) {
          throw new PolybillError("Provider cannot recover an unknown checkout outcome", {
            code: "outcome_unknown",
            operation: "checkout.recover",
            provider: this.#options.connection.provider,
            connectionId: this.#options.connection.id,
            retryable: false,
          });
        }
        const prepared = parseStoredPreparedCheckout(claim.recoveryContext);
        const recovered = await checkoutPort.recoverByIdempotencyKey(
          context,
          command.idempotencyKey,
          prepared.providerCommand,
        );
        if (recovered === undefined) {
          throw new PolybillError("Provider has not exposed the checkout outcome yet", {
            code: "outcome_unknown",
            operation: "checkout.recover",
            provider: this.#options.connection.provider,
            connectionId: this.#options.connection.id,
            retryable: true,
          });
        }
        return this.#commitRemote(scope, claim.leaseToken, prepared, recovered);
      }
      const prepared = await this.#prepare(command);
      await this.#options.store.saveRecoveryContext(scope, claim.leaseToken, prepared);
      const remote = await checkoutPort.create(context, prepared.providerCommand);
      return this.#commitRemote(scope, claim.leaseToken, prepared, remote);
    } catch (error) {
      if (error instanceof PolybillError && error.code === "outcome_unknown") {
        await this.#options.store.markUnknown(scope, claim.leaseToken, error.evidenceRef);
      } else {
        await this.#options.store.release(scope, claim.leaseToken);
      }
      throw error;
    }
  }

  async #prepare(command: CreateCheckoutCommand): Promise<PreparedCheckout> {
    assertCheckoutInput(command);
    const lines: ProviderCheckoutCommand["lines"][number][] = [];
    let total: Money | undefined;
    for (const item of command.items) {
      const price = await this.#options.store.getPrice(this.#options.tenantId, item.priceId);
      if (price === undefined || price.status !== "active") {
        throw new PolybillError("Checkout price does not exist or is retired", {
          code: "not_found",
          operation: "checkout.resolve_price",
          retryable: false,
        });
      }
      const unitAmount = fixedUnitAmount(price.model);
      const subtotal = multiplyMoney(unitAmount, item.quantity);
      total = total === undefined ? subtotal : addMoney(total, subtotal);
      const externalPriceId = await this.#options.store.getExternalId(
        this.#options.tenantId,
        this.#options.connection.id,
        "price",
        price.id,
      );
      lines.push({
        skuId: price.skuId,
        quantity: item.quantity,
        price: price.model,
        unitAmount,
        ...(externalPriceId === undefined ? {} : { externalPriceId }),
      });
    }
    if (total === undefined) throw invalidCheckout("Checkout must include at least one line item");
    const orderId = parseId<"OrderId">(this.#options.ids.next("ord"), "ord");
    const checkoutId = parseId<"CheckoutId">(this.#options.ids.next("chk"), "chk");
    const paymentId = parseId<"PaymentId">(this.#options.ids.next("pay"), "pay");
    return {
      orderId,
      checkoutId,
      paymentId,
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

  #assertAvailable(
    snapshot: Awaited<ReturnType<ProviderAdapter["getCapabilities"]>>,
    itemCount: number,
  ): void {
    const capability = snapshot.capabilities["checkout.hosted"];
    if (capability?.support !== "native" && capability?.support !== "emulated") {
      throw unsupported(this.#options.connection, capability?.reason);
    }
    if (!capability.environments.includes(this.#options.connection.environment)) {
      throw unsupported(this.#options.connection, "Capability is unavailable in this environment");
    }
    if (itemCount > 1) {
      const multi = snapshot.capabilities["checkout.multi_item"];
      if (multi?.support !== "native" && multi?.support !== "emulated") {
        throw unsupported(
          this.#options.connection,
          "Provider does not support multi-item checkout",
        );
      }
    }
    const violations = checkCommercialPolicy(
      this.#options.commercialPolicy ?? {},
      snapshot.commercialTerms,
    );
    if (violations.length > 0) {
      throw new PolybillError(`Commercial policy is incompatible: ${violations.join(", ")}`, {
        code: "commercial_policy_incompatible",
        operation: "checkout.create",
        provider: this.#options.connection.provider,
        connectionId: this.#options.connection.id,
        retryable: false,
      });
    }
  }

  async #context(idempotencyKey: IdempotencyKey): Promise<ProviderContext> {
    const now = this.#options.clock.now();
    const credentials =
      typeof this.#options.credentials === "function"
        ? await this.#options.credentials()
        : this.#options.credentials;
    return {
      tenantId: this.#options.tenantId,
      connection: this.#options.connection,
      credentials,
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

  async #hash(command: unknown): Promise<string> {
    return this.#options.crypto.sha256(new TextEncoder().encode(stableStringify(command)));
  }

  async #commitRemote(
    scope: {
      readonly tenantId: TenantId;
      readonly connectionId: ConnectionRef["id"];
      readonly operation: string;
      readonly key: IdempotencyKey;
    },
    leaseToken: string,
    prepared: PreparedCheckout,
    remote: ProviderOperationResult<ProviderCheckoutSnapshot>,
  ): Promise<CreateCheckoutResult> {
    const result = this.#toResult(prepared, remote.value, remote.warnings);
    await this.#options.store.commitCheckout({
      tenantId: this.#options.tenantId,
      connectionId: this.#options.connection.id,
      provider: this.#options.connection.provider,
      externalCheckoutId: remote.value.externalId,
      checkout: result.checkout,
      order: result.order,
      evidenceId: parseId<"EvidenceId">(this.#options.ids.next("evi"), "evi"),
      evidence: remote.evidence,
      occurredAt: this.#options.clock.now(),
    });
    await this.#options.store.complete(scope, leaseToken, result);
    return result;
  }

  #toResult(
    prepared: PreparedCheckout,
    remote: {
      readonly externalId: string;
      readonly status: string;
      readonly url?: string;
      readonly expiresAt?: IsoDateTime;
    },
    warnings: CreateCheckoutResult["warnings"],
  ): CreateCheckoutResult {
    const now = this.#options.clock.now();
    const checkout: CheckoutSession = {
      id: prepared.checkoutId,
      orderId: prepared.orderId,
      status:
        remote.status === "complete"
          ? "complete"
          : remote.status === "expired"
            ? "expired"
            : remote.status === "canceled"
              ? "canceled"
              : "open",
      ...(remote.url === undefined ? {} : { url: remote.url }),
      ...(remote.expiresAt === undefined ? {} : { expiresAt: remote.expiresAt }),
    };
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
    const pending: Payment = {
      id: prepared.paymentId,
      orderId: prepared.orderId,
      status: "pending",
      amount: prepared.providerCommand.total,
      refundedAmount: money("0", prepared.providerCommand.total.currency),
      evidence: [],
    };
    return {
      checkout,
      order,
      payment: remote.status === "complete" ? transitionPayment(pending, "succeeded") : pending,
      provider: this.#options.connection.provider,
      warnings,
    };
  }
}

interface PreparedCheckout {
  readonly orderId: OrderId;
  readonly checkoutId: CheckoutId;
  readonly paymentId: PaymentId;
  readonly lines: ProviderCheckoutCommand["lines"];
  readonly providerCommand: ProviderCheckoutCommand;
}

function assertCheckoutInput(command: CreateCheckoutCommand): void {
  if (command.items.length === 0)
    throw invalidCheckout("Checkout must include at least one line item");
  for (const item of command.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw invalidCheckout("Checkout quantities must be positive safe integers");
    }
  }
}

function unsupported(
  connection: ConnectionRef,
  reason = "Hosted checkout is unsupported",
): PolybillError {
  return new PolybillError(reason, {
    code: "unsupported_capability",
    operation: "checkout.create",
    provider: connection.provider,
    connectionId: connection.id,
    retryable: false,
  });
}
