import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderAdapter,
  type ProviderCheckoutSnapshot,
  type ProviderCustomerSnapshot,
  type ProviderContext,
  type ProviderOperationResult,
  type ProviderPriceSnapshot,
  type ProviderProductSnapshot,
  type ProviderRefundSnapshot,
  type ProviderSubscriptionSnapshot,
  type VerifiedProviderEvent,
} from "@polybill/adapter-kit";
import { PolybillError, money, parseId, type CanonicalBillingEvent } from "@polybill/core";

export interface FakeProviderOptions {
  readonly id?: string;
  readonly commercialModel?: "merchant_of_record" | "payment_processor" | "settlement_network";
  readonly hostedCheckout?: boolean;
  readonly multiItem?: boolean;
  readonly failAfterCreateOnce?: boolean;
}

export interface FakeProvider extends ProviderAdapter {
  readonly createCount: number;
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const checkouts = new Map<string, ProviderCheckoutSnapshot>();
  const byKey = new Map<string, ProviderCheckoutSnapshot>();
  const products = new Map<string, ProviderProductSnapshot>();
  const prices = new Map<string, ProviderPriceSnapshot>();
  const customers = new Map<string, ProviderCustomerSnapshot>();
  const subscriptions = new Map<string, ProviderSubscriptionSnapshot>();
  const refunds = new Map<string, ProviderRefundSnapshot>();
  let createCount = 0;
  let failAfterCreate = options.failAfterCreateOnce ?? false;
  const id = options.id ?? "default";

  function result<T extends { readonly externalId: string; readonly rawStatus?: string }>(
    context: ProviderContext,
    value: T,
  ): ProviderOperationResult<T> {
    return {
      value,
      evidence: {
        provider: "fake",
        environment: context.connection.environment,
        externalId: value.externalId,
        observedAt: context.clock.now(),
        ...(value.rawStatus === undefined ? {} : { rawStatus: value.rawStatus }),
      },
      idempotency: "both",
      warnings: [],
    };
  }

  const adapter: FakeProvider = {
    descriptor: {
      name: "fake",
      displayName: `Fake Provider ${id}`,
      adapterVersion: "0.1.0",
      maturity: "stable",
    },
    get createCount() {
      return createCount;
    },
    async getCapabilities(context): Promise<CapabilitySnapshot> {
      const hosted =
        options.hostedCheckout === false ? unsupportedCapability("disabled") : nativeCapability();
      const multi =
        options.multiItem === false ? unsupportedCapability("disabled") : nativeCapability();
      const model = options.commercialModel ?? "merchant_of_record";
      return {
        provider: "fake",
        adapterVersion: "0.1.0",
        providerApiVersion: "fake-v1",
        capabilities: {
          "checkout.hosted": hosted,
          "checkout.ad_hoc_price": nativeCapability(),
          "checkout.multi_item": multi,
          "catalog.product.read": nativeCapability(),
          "catalog.product.create": nativeCapability(),
          "catalog.product.update": nativeCapability(),
          "catalog.product.archive": nativeCapability(),
          "catalog.price.read": nativeCapability(),
          "catalog.price.create": nativeCapability(),
          "catalog.price.retire": nativeCapability(),
          "customer.read": nativeCapability(),
          "customer.create": nativeCapability(),
          "customer.update": nativeCapability(),
          "customer.delete": nativeCapability(),
          "customer.portal": nativeCapability(),
          "subscription.create": nativeCapability(),
          "subscription.read": nativeCapability(),
          "subscription.change_items": nativeCapability(),
          "subscription.pause": nativeCapability(),
          "subscription.resume": nativeCapability(),
          "subscription.cancel": nativeCapability(),
          "refund.partial": nativeCapability(),
          "refund.full": nativeCapability(),
        },
        commercialTerms: {
          model,
          sellerOfRecord: model === "merchant_of_record" ? "provider" : "merchant",
          taxCalculation: model === "merchant_of_record" ? "provider" : "merchant",
          taxInvoiceIssuer: model === "merchant_of_record" ? "provider" : "merchant",
          disputeResponsibility: model === "merchant_of_record" ? "provider" : "merchant",
          observedAt: context.clock.now(),
          evidenceRef: parseId<"EvidenceId">("evi_fake_terms", "evi"),
        },
        observedAt: context.clock.now(),
      };
    },
    catalog: {
      async createProduct(context, input) {
        const value: ProviderProductSnapshot = {
          externalId: `fake_product_${products.size + 1}`,
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          status: "active",
          rawStatus: "active",
        };
        products.set(value.externalId, value);
        return result(context, value);
      },
      async getProduct(context, externalId) {
        return result(context, required(products, externalId));
      },
      async updateProduct(context, externalId, input) {
        const current = required(products, externalId);
        const value = {
          ...current,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
        };
        products.set(externalId, value);
        return result(context, value);
      },
      async archiveProduct(context, externalId) {
        const value = { ...required(products, externalId), status: "archived" as const };
        products.set(externalId, value);
        return result(context, value);
      },
      async createPrice(context, input) {
        const value: ProviderPriceSnapshot = {
          externalId: `fake_price_${prices.size + 1}`,
          externalProductId: input.externalProductId,
          model: input.model,
          status: "active",
          rawStatus: "active",
        };
        prices.set(value.externalId, value);
        return result(context, value);
      },
      async getPrice(context, externalId) {
        return result(context, required(prices, externalId));
      },
      async retirePrice(context, externalId) {
        const value = { ...required(prices, externalId), status: "retired" as const };
        prices.set(externalId, value);
        return result(context, value);
      },
    },
    customers: {
      async create(context, input) {
        const value: ProviderCustomerSnapshot = {
          externalId: `fake_customer_${customers.size + 1}`,
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.name === undefined ? {} : { name: input.name }),
          status: "active",
        };
        customers.set(value.externalId, value);
        return result(context, value);
      },
      async get(context, externalId) {
        return result(context, required(customers, externalId));
      },
      async update(context, externalId, input) {
        const current = required(customers, externalId);
        const value = { ...current, ...input };
        customers.set(externalId, value);
        return result(context, value);
      },
      async tombstone(context, externalId) {
        const value = { ...required(customers, externalId), status: "tombstoned" as const };
        customers.set(externalId, value);
        return result(context, value);
      },
      async portal(context, externalId) {
        required(customers, externalId);
        return result(context, {
          externalId,
          url: `https://portal.fake.invalid/${externalId}`,
        });
      },
    },
    checkout: {
      async create(context, command) {
        const key = context.idempotencyKey;
        if (key !== undefined) {
          const existing = byKey.get(key);
          if (existing !== undefined) return result(context, existing);
        }
        createCount += 1;
        const externalId = `fake_checkout_${id}_${String(createCount).padStart(6, "0")}`;
        const snapshot: ProviderCheckoutSnapshot = {
          externalId,
          status: "open",
          url: `https://checkout.fake.invalid/${externalId}`,
          rawStatus: "created",
        };
        checkouts.set(externalId, snapshot);
        if (key !== undefined) byKey.set(key, snapshot);
        if (failAfterCreate) {
          failAfterCreate = false;
          throw new PolybillError("Fake response lost after create", {
            code: "outcome_unknown",
            operation: "checkout.create",
            provider: "fake",
            retryable: true,
          });
        }
        void command;
        return result(context, snapshot);
      },
      async get(context, externalId) {
        const found = checkouts.get(externalId);
        if (found === undefined) throw new Error("Fake checkout not found");
        return result(context, found);
      },
      async recoverByIdempotencyKey(context, key, command) {
        void command;
        const found = byKey.get(key);
        return found === undefined ? undefined : result(context, found);
      },
    },
    subscriptions: {
      async create(context, input) {
        const value: ProviderSubscriptionSnapshot = {
          externalId: `fake_subscription_${subscriptions.size + 1}`,
          externalCustomerId: input.externalCustomerId,
          status: input.trial === undefined ? "active" : "trialing",
          items: input.items,
          cancelAtPeriodEnd: false,
          rawStatus: input.trial === undefined ? "active" : "trialing",
        };
        subscriptions.set(value.externalId, value);
        return result(context, value);
      },
      async get(context, externalId) {
        return result(context, required(subscriptions, externalId));
      },
      async changeItems(context, externalId, items) {
        const value = { ...required(subscriptions, externalId), items };
        subscriptions.set(externalId, value);
        return result(context, value);
      },
      async pause(context, externalId) {
        const value: ProviderSubscriptionSnapshot = {
          ...required(subscriptions, externalId),
          status: "paused",
          rawStatus: "paused",
        };
        subscriptions.set(externalId, value);
        return result(context, value);
      },
      async resume(context, externalId) {
        const value: ProviderSubscriptionSnapshot = {
          ...required(subscriptions, externalId),
          status: "active",
          rawStatus: "active",
        };
        subscriptions.set(externalId, value);
        return result(context, value);
      },
      async cancel(context, externalId, timing) {
        const current = required(subscriptions, externalId);
        const value: ProviderSubscriptionSnapshot = {
          ...current,
          status: timing === "immediately" ? "canceled" : current.status,
          cancelAtPeriodEnd: timing === "period_end",
          rawStatus: timing === "immediately" ? "canceled" : "active_canceling",
        };
        subscriptions.set(externalId, value);
        return result(context, value);
      },
    },
    refunds: {
      async create(context, input) {
        const value: ProviderRefundSnapshot = {
          externalId: `fake_refund_${refunds.size + 1}`,
          externalPaymentId: input.externalPaymentId,
          amount: input.amount ?? money("0", "USD"),
          status: "succeeded",
          rawStatus: "succeeded",
        };
        refunds.set(value.externalId, value);
        return result(context, value);
      },
      async get(context, externalId) {
        return result(context, required(refunds, externalId));
      },
    },
    webhooks: {
      async verify(input): Promise<VerifiedProviderEvent> {
        return {
          provider: "fake",
          environment: input.environment,
          deliveryKey: `fake:${input.rawBody.byteLength}`,
          rawBody: input.rawBody,
          verifiedAt: input.now,
          keyId: input.secret.activeKeyId,
        };
      },
      decode: () => ({ type: "unknown", externalIds: {}, payload: {} }),
      map: async (): Promise<readonly CanonicalBillingEvent[]> => [],
    },
    reconcile: { checkout: async () => [] },
  };
  return adapter;
}

function required<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (value === undefined) throw new Error("Fake provider resource was not found");
  return value;
}
