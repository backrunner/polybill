import type {
  CryptoPort,
  CredentialResolver,
  ProviderAdapter,
  ProviderCheckoutCommand,
  ProviderContext,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  addMoney,
  checkCommercialPolicy,
  multiplyMoney,
  parseId,
  parseIsoDateTime,
  type CheckoutSession,
  type CommercialPolicy,
  type ConnectionRef,
  type CustomerId,
  type DiscountId,
  type DiscountRedemptionId,
  type EvidenceId,
  type IdempotencyKey,
  type Money,
  type Order,
  type Payment,
  type TenantId,
} from "@polybill/core";
import {
  assertCheckoutItems,
  fixedUnitAmount,
  invalidCheckout,
  parseStoredCheckoutResult,
  parseStoredPreparedCheckout,
  stableStringify,
  validatedRedirectUrl,
  type StoredPreparedCheckout,
} from "./checkout-helpers.js";
import type { ApplicationStore, IdGenerator, Logger } from "./ports.js";
import { AdHocCheckoutService, type CreateAdHocCheckoutCommand } from "./ad-hoc-checkout.js";
import { prepareCheckoutDiscount } from "./checkout-discount.js";
import { commitRemoteCheckout } from "./checkout-result.js";

export interface CreateCheckoutItem {
  readonly priceId: string;
  readonly quantity: number;
}

export interface CreateCheckoutCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly customerId?: CustomerId;
  readonly customerEmail?: string;
  readonly discountId?: DiscountId;
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
  readonly #adHoc: AdHocCheckoutService;

  constructor(options: CheckoutServiceOptions) {
    if (options.connection.tenantId !== options.tenantId) {
      throw new PolybillError("Connection does not belong to the requested tenant", {
        code: "invalid_request",
        operation: "checkout.initialize",
        retryable: false,
      });
    }
    this.#options = options;
    this.#adHoc = new AdHocCheckoutService(options);
  }

  async create(command: CreateCheckoutCommand): Promise<CreateCheckoutResult> {
    assertCheckoutItems(command.items);
    validatedRedirectUrl(command.successUrl);
    validatedRedirectUrl(command.cancelUrl);
    const context = await this.#context(command.idempotencyKey);
    const capabilities = await this.#options.adapter.getCapabilities(context);
    this.#assertAvailable(capabilities, command.items.length, command.discountId !== undefined);

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

    let discountReservationId: DiscountRedemptionId | undefined;
    let remoteObserved = false;
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
        remoteObserved = true;
        return await commitRemoteCheckout(
          this.#options,
          scope,
          claim.leaseToken,
          prepared,
          recovered,
        );
      }
      const prepared = await this.#prepare(command, payloadHash);
      discountReservationId = prepared.discountReservationId;
      await this.#options.store.saveRecoveryContext(scope, claim.leaseToken, prepared);
      const remote = await checkoutPort.create(context, prepared.providerCommand);
      remoteObserved = true;
      return await commitRemoteCheckout(this.#options, scope, claim.leaseToken, prepared, remote);
    } catch (error) {
      if ((error instanceof PolybillError && error.code === "outcome_unknown") || remoteObserved) {
        if (claim.kind === "claimed")
          await this.#options.store.markUnknown(
            scope,
            claim.leaseToken,
            error instanceof PolybillError ? error.evidenceRef : undefined,
          );
      } else if (claim.kind === "claimed") {
        if (discountReservationId !== undefined)
          await this.#options.store.releaseDiscountReservation(
            this.#options.tenantId,
            discountReservationId,
          );
        await this.#options.store.release(scope, claim.leaseToken);
      }
      throw error;
    }
  }

  async createAdHoc(command: CreateAdHocCheckoutCommand): Promise<CreateCheckoutResult> {
    return this.#adHoc.create(command);
  }

  async #prepare(command: CreateCheckoutCommand, payloadHash: string): Promise<PreparedCheckout> {
    assertCheckoutItems(command.items);
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
    const grossTotal = total;
    const discount =
      command.discountId === undefined
        ? undefined
        : await prepareCheckoutDiscount(
            this.#options,
            { ...command, discountId: command.discountId },
            lines,
            payloadHash,
          );
    total = discount?.net ?? grossTotal;
    const orderId = parseId<"OrderId">(this.#options.ids.next("ord"), "ord");
    const checkoutId = parseId<"CheckoutId">(this.#options.ids.next("chk"), "chk");
    const paymentId = parseId<"PaymentId">(this.#options.ids.next("pay"), "pay");
    return {
      orderId,
      checkoutId,
      paymentId,
      commercialTermsRef: parseId<"EvidenceId">(this.#options.ids.next("evi"), "evi"),
      evidenceId: parseId<"EvidenceId">(this.#options.ids.next("evi"), "evi"),
      lines,
      ...(discount === undefined ? {} : { discountReservationId: discount.reservationId }),
      providerCommand: {
        orderId,
        ...(command.customerId === undefined ? {} : { customerId: command.customerId }),
        ...(command.customerEmail === undefined ? {} : { customerEmail: command.customerEmail }),
        lines,
        grossTotal,
        ...(discount === undefined
          ? {}
          : {
              discount: {
                discountId: discount.discount.id,
                code: discount.discount.code,
                amount: discount.amount,
                externalDiscountId: discount.externalDiscountId,
              },
            }),
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
    hasDiscount: boolean,
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
    if (hasDiscount) {
      const discount = snapshot.capabilities["checkout.discount"];
      if (
        (discount?.support !== "native" && discount?.support !== "emulated") ||
        !discount.environments.includes(this.#options.connection.environment)
      )
        throw unsupported(
          this.#options.connection,
          discount?.support === "unsupported"
            ? discount.reason
            : "Provider does not support canonical checkout discounts",
        );
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
}

interface PreparedCheckout extends StoredPreparedCheckout {
  readonly commercialTermsRef: EvidenceId;
  readonly evidenceId: EvidenceId;
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
