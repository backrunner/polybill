import {
  createWebCryptoPort,
  type CapabilitySnapshot,
  type CredentialResolver,
  type CryptoPort,
  type ProviderAdapter,
  type ProviderContext,
  type ResolvedCredentials,
} from "@polybill/adapter-kit";
import {
  CheckoutService,
  type ApplicationStore,
  type IdGenerator,
  type Logger,
} from "@polybill/application";
import {
  parseId,
  parseIsoDateTime,
  type Clock,
  type CommercialPolicy,
  type ConnectionRef,
  type TenantId,
} from "@polybill/core";
import { noopLogger, SecureIdGenerator, systemClock } from "./runtime.js";

export interface PolybillOptions {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly credentials: ResolvedCredentials | CredentialResolver;
  readonly adapter: ProviderAdapter;
  readonly store: ApplicationStore;
  readonly crypto?: CryptoPort;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: Logger;
  readonly commercialPolicy?: CommercialPolicy;
  readonly timeoutMs?: number;
}

export interface PolybillClient {
  readonly checkouts: CheckoutService;
  getCapabilities(): Promise<CapabilitySnapshot>;
}

export function createPolybill(options: PolybillOptions): PolybillClient {
  const crypto = options.crypto ?? createWebCryptoPort();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new SecureIdGenerator(crypto);
  const fetch = options.fetch ?? globalThis.fetch;
  if (fetch === undefined) throw new Error("Fetch is unavailable in this runtime");

  const shared = {
    tenantId: options.tenantId,
    connection: options.connection,
    credentials: options.credentials,
    adapter: options.adapter,
    store: options.store,
    crypto,
    clock,
    ids,
    fetch,
    logger: options.logger ?? noopLogger,
    ...(options.commercialPolicy === undefined
      ? {}
      : { commercialPolicy: options.commercialPolicy }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  return {
    checkouts: new CheckoutService(shared),
    async getCapabilities() {
      const context = await providerContext(shared, undefined);
      return options.adapter.getCapabilities(context);
    },
  };
}

async function providerContext(
  options: {
    readonly tenantId: TenantId;
    readonly connection: ConnectionRef;
    readonly credentials: ResolvedCredentials | CredentialResolver;
    readonly crypto: CryptoPort;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly fetch: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
  idempotencyKey: ProviderContext["idempotencyKey"],
): Promise<ProviderContext> {
  const now = options.clock.now();
  const credentials =
    typeof options.credentials === "function" ? await options.credentials() : options.credentials;
  return {
    tenantId: options.tenantId,
    connection: options.connection,
    credentials,
    requestId: parseId<"RequestId">(options.ids.next("req"), "req"),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    deadline: parseIsoDateTime(
      new Date(Date.parse(now) + (options.timeoutMs ?? 10_000)).toISOString(),
    ),
    fetch: options.fetch,
    crypto: options.crypto,
    clock: options.clock,
  };
}
