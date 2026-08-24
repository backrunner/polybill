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
  CatalogService,
  CatalogSyncService,
  CheckoutService,
  CommerceQueryService,
  CustomerService,
  RefundService,
  ReconciliationService,
  ResourceRuntime,
  SubscriptionService,
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
import {
  LicenseService,
  VoucherService,
  type LicensingStore,
  type SecretCrypto,
} from "@polybill/licensing";
import { MigrationRunner, type MigrationStore, type MigrationTarget } from "@polybill/migration";
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
  readonly licensing?: {
    readonly store: LicensingStore;
    readonly crypto: SecretCrypto;
  };
  readonly migration?: {
    readonly store: MigrationStore;
    readonly target: MigrationTarget;
  };
}

export interface PolybillClient {
  readonly catalog: CatalogService;
  readonly catalogSync: CatalogSyncService;
  readonly customers: CustomerService;
  readonly checkouts: CheckoutService;
  readonly orders: {
    get(
      id: Parameters<CommerceQueryService["order"]>[0],
    ): ReturnType<CommerceQueryService["order"]>;
  };
  readonly payments: {
    get(
      id: Parameters<CommerceQueryService["payment"]>[0],
    ): ReturnType<CommerceQueryService["payment"]>;
  };
  readonly refunds: RefundService;
  readonly subscriptions: SubscriptionService;
  readonly reconcile: ReconciliationService;
  readonly licenses: LicenseService | undefined;
  readonly vouchers: VoucherService | undefined;
  readonly migrations: MigrationRunner | undefined;
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
  const resources = new ResourceRuntime(shared);
  const queries = new CommerceQueryService(resources);
  const licenses =
    options.licensing === undefined
      ? undefined
      : new LicenseService({
          store: options.licensing.store,
          crypto: options.licensing.crypto,
          ids,
          clock,
        });
  const vouchers =
    options.licensing === undefined
      ? undefined
      : new VoucherService({
          store: options.licensing.store,
          crypto: options.licensing.crypto,
          ids,
          clock,
        });

  return {
    catalog: new CatalogService(resources),
    catalogSync: new CatalogSyncService(resources),
    customers: new CustomerService(resources),
    checkouts: new CheckoutService(shared),
    orders: { get: (id) => queries.order(id) },
    payments: { get: (id) => queries.payment(id) },
    refunds: new RefundService(resources),
    subscriptions: new SubscriptionService(resources),
    reconcile: new ReconciliationService(resources),
    licenses,
    vouchers,
    migrations:
      options.migration === undefined ? undefined : new MigrationRunner(options.migration),
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
