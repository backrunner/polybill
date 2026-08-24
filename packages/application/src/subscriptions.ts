import {
  PolybillError,
  assertSubscriptionItemChangePolicy,
  parseId,
  type CustomerId,
  type IdempotencyKey,
  type PriceId,
  type Subscription,
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionStatus,
} from "@polybill/core";
import { requireExternalId } from "./resource-runtime.js";
import type { ResourceRuntime } from "./resource-runtime.js";

export interface CreateSubscriptionCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly customerId: CustomerId;
  readonly items: readonly { readonly priceId: PriceId; readonly quantity: number }[];
  readonly trial?: { readonly unit: "day" | "week" | "month" | "year"; readonly count: number };
  readonly metadata?: Readonly<Record<string, string>>;
}

export class SubscriptionService {
  readonly #runtime: ResourceRuntime;
  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async create(command: CreateSubscriptionCommand): Promise<Subscription> {
    if (
      command.items.length === 0 ||
      command.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)
    )
      throw new TypeError("Subscription items are invalid");
    return this.#runtime.mutate({
      operation: "subscription.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability("subscription.create", context);
        const port = this.#runtime.options.adapter.subscriptions?.create;
        if (port === undefined) throw unsupported("subscription.create");
        const externalCustomerId = requireExternalId(
          await mapping(this.#runtime, "customer", command.customerId),
          "subscription.create",
        );
        const items = await Promise.all(
          command.items.map(async (item) => ({
            externalPriceId: requireExternalId(
              await mapping(this.#runtime, "price", item.priceId),
              "subscription.create",
            ),
            quantity: item.quantity,
          })),
        );
        const remote = await port(context, {
          externalCustomerId,
          items,
          ...(command.trial === undefined ? {} : { trial: command.trial }),
          metadata: command.metadata ?? {},
        });
        const id = parseId<"SubscriptionId">(this.#runtime.options.ids.next("sub"), "sub");
        const subscription = canonical(id, command.customerId, command.items, remote.value, 1);
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "subscription",
          entityId: id,
          externalId: remote.value.externalId,
          value: subscription,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return subscription;
      },
    });
  }

  async cancel(
    id: Subscription["id"],
    idempotencyKey: IdempotencyKey,
    timing: "immediately" | "period_end",
  ): Promise<Subscription> {
    const current = await this.get(id);
    if (current === undefined) throw notFound();
    return this.#runtime.mutate({
      operation: "subscription.cancel",
      key: idempotencyKey,
      payload: { id, timing },
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability("subscription.cancel", context);
        const port = this.#runtime.options.adapter.subscriptions?.cancel;
        if (port === undefined) throw unsupported("subscription.cancel");
        const externalId = requireExternalId(
          await mapping(this.#runtime, "subscription", id),
          "subscription.cancel",
        );
        const remote = await port(context, externalId, timing);
        const updated = canonical(
          id,
          current.customerId,
          current.items,
          remote.value,
          current.version + 1,
        );
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "subscription",
          entityId: id,
          externalId,
          value: updated,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return updated;
      },
    });
  }

  async changeItems(
    id: Subscription["id"],
    idempotencyKey: IdempotencyKey,
    items: readonly { readonly priceId: PriceId; readonly quantity: number }[],
    policy: SubscriptionItemChangePolicy,
  ): Promise<Subscription> {
    assertItems(items);
    assertSubscriptionItemChangePolicy(policy);
    const current = await this.get(id);
    if (current === undefined) throw notFound();
    return this.#runtime.mutate({
      operation: "subscription.change_items",
      key: idempotencyKey,
      payload: { id, items, policy },
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability("subscription.change_items", context);
        const port = this.#runtime.options.adapter.subscriptions?.changeItems;
        if (port === undefined) throw unsupported("subscription.change_items");
        const externalId = requireExternalId(
          await mapping(this.#runtime, "subscription", id),
          "subscription.change_items",
        );
        const externalItems = await Promise.all(
          items.map(async (item) => ({
            externalPriceId: requireExternalId(
              await mapping(this.#runtime, "price", item.priceId),
              "subscription.change_items",
            ),
            quantity: item.quantity,
          })),
        );
        const remote = await port(context, externalId, { items: externalItems, policy });
        const updated = canonical(id, current.customerId, items, remote.value, current.version + 1);
        await commit(this.#runtime, updated, externalId, remote.evidence);
        return updated;
      },
    });
  }

  pause(
    id: Subscription["id"],
    idempotencyKey: IdempotencyKey,
    policy: SubscriptionPausePolicy,
  ): Promise<Subscription> {
    return this.#lifecycle(id, idempotencyKey, "pause", policy);
  }

  resume(id: Subscription["id"], idempotencyKey: IdempotencyKey): Promise<Subscription> {
    return this.#lifecycle(id, idempotencyKey, "resume");
  }

  get(id: Subscription["id"]): Promise<Subscription | undefined> {
    return this.#runtime.options.store.getResource(
      this.#runtime.options.tenantId,
      "subscription",
      id,
    );
  }

  async refresh(id: Subscription["id"], idempotencyKey: IdempotencyKey): Promise<Subscription> {
    const current = await this.get(id);
    if (current === undefined) throw notFound();
    return this.#runtime.mutate({
      operation: "subscription.refresh",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability("subscription.read", context);
        const port = this.#runtime.options.adapter.subscriptions?.get;
        if (port === undefined) throw unsupported("subscription.read");
        const externalId = requireExternalId(
          await mapping(this.#runtime, "subscription", id),
          "subscription.read",
        );
        const remote = await port(context, externalId);
        const items = await Promise.all(
          remote.value.items.map(async (item) => {
            const canonicalId = await this.#runtime.options.store.findCanonicalId(
              this.#runtime.options.tenantId,
              this.#runtime.options.connection.id,
              "price",
              item.externalPriceId,
            );
            return {
              priceId: requirePriceId(canonicalId),
              quantity: item.quantity,
            };
          }),
        );
        const updated = canonical(id, current.customerId, items, remote.value, current.version + 1);
        await commit(this.#runtime, updated, externalId, remote.evidence);
        return updated;
      },
    });
  }

  async #lifecycle(
    id: Subscription["id"],
    idempotencyKey: IdempotencyKey,
    action: "pause" | "resume",
    pausePolicy?: SubscriptionPausePolicy,
  ): Promise<Subscription> {
    const current = await this.get(id);
    if (current === undefined) throw notFound();
    const operation = `subscription.${action}` as const;
    return this.#runtime.mutate({
      operation,
      key: idempotencyKey,
      payload: { id, action, ...(pausePolicy === undefined ? {} : { policy: pausePolicy }) },
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability(operation, context);
        const subscriptions = this.#runtime.options.adapter.subscriptions;
        const externalId = requireExternalId(
          await mapping(this.#runtime, "subscription", id),
          operation,
        );
        const remote = await lifecycleRemote(
          subscriptions,
          action,
          context,
          externalId,
          pausePolicy,
        );
        const updated = canonical(
          id,
          current.customerId,
          current.items,
          remote.value,
          current.version + 1,
        );
        await commit(this.#runtime, updated, externalId, remote.evidence);
        return updated;
      },
    });
  }
}

function canonical(
  id: Subscription["id"],
  customerId: CustomerId,
  items: Subscription["items"],
  remote: {
    status: SubscriptionStatus | "unknown";
    currentPeriodStart?: Subscription["currentPeriodStart"];
    currentPeriodEnd?: Subscription["currentPeriodEnd"];
    cancelAtPeriodEnd: boolean;
    rawStatus: string;
  },
  version: number,
): Subscription {
  if (remote.status === "unknown")
    throw new PolybillError("Provider returned an unknown subscription status", {
      code: "provider_response_invalid",
      operation: "subscription.decode",
      retryable: false,
    });
  return {
    id,
    customerId,
    status: remote.status,
    items,
    ...(remote.currentPeriodStart === undefined
      ? {}
      : { currentPeriodStart: remote.currentPeriodStart }),
    ...(remote.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: remote.currentPeriodEnd }),
    ...(remote.cancelAtPeriodEnd && remote.currentPeriodEnd !== undefined
      ? { scheduledChange: { kind: "cancel" as const, effectiveAt: remote.currentPeriodEnd } }
      : {}),
    version,
    rawStatus: remote.rawStatus,
  };
}
async function mapping(runtime: ResourceRuntime, type: string, id: string) {
  return runtime.options.store.getExternalId(
    runtime.options.tenantId,
    runtime.options.connection.id,
    type,
    id,
  );
}
async function commit(
  runtime: ResourceRuntime,
  subscription: Subscription,
  externalId: string,
  evidence: unknown,
): Promise<void> {
  await runtime.options.store.commitResource({
    tenantId: runtime.options.tenantId,
    connectionId: runtime.options.connection.id,
    provider: runtime.options.connection.provider,
    entityType: "subscription",
    entityId: subscription.id,
    externalId,
    value: subscription,
    evidence,
    occurredAt: runtime.options.clock.now(),
  });
}
function assertItems(items: readonly { readonly quantity: number }[]): void {
  if (
    items.length === 0 ||
    items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)
  )
    throw new TypeError("Subscription items are invalid");
}
function decodeSubscription(value: unknown): Subscription {
  if (typeof value !== "object" || value === null || !("id" in value) || !("items" in value))
    throw new TypeError("Stored subscription replay is invalid");
  return value as Subscription;
}
function unsupported(operation: string) {
  return new PolybillError("Provider subscription capability is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}
function notFound() {
  return new PolybillError("Canonical subscription was not found", {
    code: "not_found",
    operation: "subscription.get",
    retryable: false,
  });
}
function requirePriceId(value: string | undefined): PriceId {
  if (value === undefined)
    throw new PolybillError("Provider subscription item has no canonical price mapping", {
      code: "not_found",
      operation: "subscription.read",
      retryable: false,
    });
  return parseId<"PriceId">(value, "price");
}

function requirePausePolicy(policy: SubscriptionPausePolicy | undefined): SubscriptionPausePolicy {
  if (policy === undefined) throw new TypeError("Pause policy is required");
  return policy;
}

async function lifecycleRemote(
  subscriptions: ResourceRuntime["options"]["adapter"]["subscriptions"],
  action: "pause" | "resume",
  context: Parameters<NonNullable<NonNullable<typeof subscriptions>["get"]>>[0],
  externalId: string,
  pausePolicy: SubscriptionPausePolicy | undefined,
) {
  if (action === "pause") {
    const pause = subscriptions?.pause;
    if (pause === undefined) throw unsupported("subscription.pause");
    return pause(context, externalId, requirePausePolicy(pausePolicy));
  }
  const resume = subscriptions?.resume;
  if (resume === undefined) throw unsupported("subscription.resume");
  return resume(context, externalId);
}
