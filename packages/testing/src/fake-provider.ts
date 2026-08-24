import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderAdapter,
  type ProviderCheckoutSnapshot,
  type ProviderContext,
  type ProviderOperationResult,
  type VerifiedProviderEvent,
} from "@polybill/adapter-kit";
import { PolybillError, parseId, type CanonicalBillingEvent } from "@polybill/core";

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
  let createCount = 0;
  let failAfterCreate = options.failAfterCreateOnce ?? false;
  const id = options.id ?? "default";

  function result(
    context: ProviderContext,
    value: ProviderCheckoutSnapshot,
  ): ProviderOperationResult<ProviderCheckoutSnapshot> {
    return {
      value,
      evidence: {
        provider: "fake",
        environment: context.connection.environment,
        externalId: value.externalId,
        observedAt: context.clock.now(),
        rawStatus: value.rawStatus,
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
        capabilities: { "checkout.hosted": hosted, "checkout.multi_item": multi },
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
      async recoverByIdempotencyKey(context, key) {
        const found = byKey.get(key);
        return found === undefined ? undefined : result(context, found);
      },
    },
    webhooks: {
      async verify(input): Promise<VerifiedProviderEvent> {
        return {
          provider: "fake",
          environment: "test",
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
