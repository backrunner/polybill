import type {
  ProviderContext,
  ProviderOperationResult,
  ProviderSubscriptionSnapshot,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  assertSubscriptionItemChangePolicy,
  assertSubscriptionPausePolicy,
  assertFutureSubscriptionDate,
  parseId,
  validateBillingInterval,
  type CustomerId,
  type IdempotencyKey,
  type PriceId,
  type Subscription,
  type SubscriptionItemChangePolicy,
  type SubscriptionPausePolicy,
  type SubscriptionScheduledChangeKind,
  type SubscriptionTrialEnd,
  type SubscriptionResumePolicy,
} from "@polybill/core";
import type { ResourceRuntime } from "./resource-runtime.js";
import { saveSubscription, subscriptionMapping } from "./subscription-snapshot.js";
import { assertSubscriptionOutcome } from "./subscription-outcome.js";

export interface CreateSubscriptionCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly customerId: CustomerId;
  readonly items: readonly { readonly priceId: PriceId; readonly quantity: number }[];
  readonly trial?: { readonly unit: "day" | "week" | "month" | "year"; readonly count: number };
  readonly metadata?: Readonly<Record<string, string>>;
}

type Action =
  | "read"
  | "cancel"
  | "change_items"
  | "pause"
  | "resume"
  | "clear_scheduled_change"
  | "set_trial_end";

export class SubscriptionService {
  readonly #runtime: ResourceRuntime;
  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async create(command: CreateSubscriptionCommand): Promise<Subscription> {
    assertItems(command.items);
    if (command.trial !== undefined) validateBillingInterval(command.trial);
    return this.#runtime.mutate({
      operation: "subscription.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability("subscription.create", context);
        if (command.trial !== undefined)
          await this.#runtime.requireCapability("subscription.trial", context);
        const port = this.#runtime.options.adapter.subscriptions?.create;
        if (port === undefined) throw unsupported("subscription.create");
        const remote = await port(context, {
          externalCustomerId: await subscriptionMapping(
            this.#runtime,
            "customer",
            command.customerId,
          ),
          items: await this.#externalItems(command.items),
          ...(command.trial === undefined ? {} : { trial: command.trial }),
          metadata: command.metadata ?? {},
        });
        return saveSubscription(
          this.#runtime,
          parseId<"SubscriptionId">(this.#runtime.options.ids.next("sub"), "sub"),
          command.customerId,
          remote,
          1,
        );
      },
    });
  }

  get(id: Subscription["id"]): Promise<Subscription | undefined> {
    return this.#runtime.options.store.getResource(
      this.#runtime.options.tenantId,
      "subscription",
      id,
    );
  }

  refresh(id: Subscription["id"], key: IdempotencyKey): Promise<Subscription> {
    return this.#update(id, key, "read", {}, async (context, externalId) => {
      const port = this.#runtime.options.adapter.subscriptions?.get;
      if (port === undefined) throw unsupported("subscription.read");
      return port(context, externalId);
    });
  }

  cancel(
    id: Subscription["id"],
    key: IdempotencyKey,
    timing: "immediately" | "period_end",
  ): Promise<Subscription> {
    if (timing !== "immediately" && timing !== "period_end")
      throw new TypeError("Invalid cancellation timing");
    return this.#update(id, key, "cancel", { timing }, async (context, externalId, current) => {
      const port = this.#runtime.options.adapter.subscriptions?.cancel;
      if (port === undefined) throw unsupported("subscription.cancel");
      const result = await port(context, externalId, timing);
      assertSubscriptionOutcome(
        result.value,
        { action: "cancel", timing, previous: current.status },
        context.clock.now(),
        context.connection.provider,
      );
      return result;
    });
  }

  changeItems(
    id: Subscription["id"],
    key: IdempotencyKey,
    items: Subscription["items"],
    policy: SubscriptionItemChangePolicy,
  ): Promise<Subscription> {
    assertItems(items);
    assertSubscriptionItemChangePolicy(policy);
    return this.#update(
      id,
      key,
      "change_items",
      { items, policy },
      async (context, externalId, current) => {
        const port = this.#runtime.options.adapter.subscriptions?.changeItems;
        if (port === undefined) throw unsupported("subscription.change_items");
        const desired = await this.#externalItems(items);
        const remote = await port(context, externalId, { items: desired, policy });
        const applied = sameItems(desired, remote.value.items);
        const scheduled = remote.value.scheduledChange;
        const alreadyCurrent =
          items.length === current.items.length &&
          items.every((item) =>
            current.items.some(
              (entry) => entry.priceId === item.priceId && entry.quantity === item.quantity,
            ),
          );
        const confirmedSchedule =
          policy.timing === "period_end" &&
          scheduled?.kind === "items" &&
          scheduled.items !== undefined &&
          sameItems(desired, scheduled.items);
        const confirmed =
          policy.timing === "immediately"
            ? applied
            : confirmedSchedule || (applied && alreadyCurrent && scheduled?.kind !== "items");
        if (!confirmed)
          throw new PolybillError("Provider has not confirmed the requested subscription items", {
            code: "outcome_unknown",
            operation: "subscription.change_items",
            retryable: false,
          });
        return remote;
      },
    );
  }

  pause(
    id: Subscription["id"],
    key: IdempotencyKey,
    policy: SubscriptionPausePolicy,
  ): Promise<Subscription> {
    return this.#update(id, key, "pause", { policy }, async (context, externalId) => {
      assertSubscriptionPausePolicy(policy, context.clock.now());
      const port = this.#runtime.options.adapter.subscriptions?.pause;
      if (port === undefined) throw unsupported("subscription.pause");
      const result = await port(context, externalId, policy);
      assertSubscriptionOutcome(
        result.value,
        { action: "pause", policy },
        context.clock.now(),
        context.connection.provider,
      );
      return result;
    });
  }

  resume(
    id: Subscription["id"],
    key: IdempotencyKey,
    policy?: SubscriptionResumePolicy,
  ): Promise<Subscription> {
    if (policy !== undefined && !["continue_current", "restart"].includes(policy.billingPeriod))
      throw new TypeError("Invalid resume billing-period policy");
    return this.#update(
      id,
      key,
      "resume",
      policy === undefined ? {} : { policy },
      async (context, externalId) => {
        const ports = this.#runtime.options.adapter.subscriptions;
        const legacy = ports?.resume;
        const explicit = ports?.resumeWithPolicy;
        let result: ProviderOperationResult<ProviderSubscriptionSnapshot>;
        if (policy === undefined) {
          if (legacy === undefined) throw unsupported("subscription.resume");
          result = await legacy(context, externalId);
        } else {
          if (explicit === undefined) throw unsupported("subscription.resume");
          result = await explicit(context, externalId, policy);
        }
        assertSubscriptionOutcome(
          result.value,
          { action: "resume" },
          context.clock.now(),
          context.connection.provider,
        );
        return result;
      },
    );
  }

  clearScheduledChange(
    id: Subscription["id"],
    key: IdempotencyKey,
    kind: SubscriptionScheduledChangeKind,
  ): Promise<Subscription> {
    if (!["cancel", "pause", "items"].includes(kind))
      throw new TypeError("Invalid scheduled change kind");
    return this.#update(
      id,
      key,
      "clear_scheduled_change",
      { kind },
      async (context, externalId) => {
        const port = this.#runtime.options.adapter.subscriptions?.clearScheduledChange;
        if (port === undefined) throw unsupported("subscription.clear_scheduled_change");
        const result = await port(context, externalId, kind);
        assertSubscriptionOutcome(
          result.value,
          { action: "clear_scheduled_change", kind },
          context.clock.now(),
          context.connection.provider,
        );
        return result;
      },
    );
  }

  setTrialEnd(
    id: Subscription["id"],
    key: IdempotencyKey,
    end: SubscriptionTrialEnd,
  ): Promise<Subscription> {
    return this.#update(id, key, "set_trial_end", { end }, async (context, externalId) => {
      if (end !== "now") assertFutureSubscriptionDate(end, context.clock.now());
      const port = this.#runtime.options.adapter.subscriptions?.setTrialEnd;
      if (port === undefined) throw unsupported("subscription.set_trial_end");
      const result = await port(context, externalId, end);
      assertSubscriptionOutcome(
        result.value,
        { action: "set_trial_end", end },
        context.clock.now(),
        context.connection.provider,
      );
      return result;
    });
  }

  #externalItems(items: Subscription["items"]) {
    return Promise.all(
      items.map(async (item) => ({
        externalPriceId: await subscriptionMapping(this.#runtime, "price", item.priceId),
        quantity: item.quantity,
      })),
    );
  }

  #update(
    id: Subscription["id"],
    key: IdempotencyKey,
    action: Action,
    payload: Readonly<Record<string, unknown>>,
    run: (
      context: ProviderContext,
      externalId: string,
      current: Subscription,
    ) => Promise<ProviderOperationResult<ProviderSubscriptionSnapshot>>,
  ): Promise<Subscription> {
    const capability = `subscription.${action}` as const;
    return this.#runtime.mutate({
      operation: action === "read" ? "subscription.refresh" : capability,
      key,
      payload: { id, ...payload },
      decodeReplay: decodeSubscription,
      execute: async (context) => {
        await this.#runtime.requireCapability(capability, context);
        const current = await this.get(id);
        if (current === undefined)
          throw new PolybillError("Canonical subscription was not found", {
            code: "not_found",
            operation: capability,
            retryable: false,
          });
        const externalId = await subscriptionMapping(this.#runtime, "subscription", id);
        if (current.status === "canceled" && action !== "read" && action !== "cancel")
          throw new PolybillError("A canceled subscription cannot return to a billable state", {
            code: "invalid_request",
            operation: capability,
            provider: context.connection.provider,
            retryable: false,
          });
        const remote = await run(context, externalId, current);
        if (remote.value.externalId !== externalId)
          throw new PolybillError("Subscription response ID mismatch", {
            code: "provider_response_invalid",
            operation: capability,
            retryable: false,
          });
        try {
          return await saveSubscription(
            this.#runtime,
            id,
            current.customerId,
            remote,
            current.version + 1,
            current,
          );
        } catch (error) {
          if (
            action !== "read" &&
            error instanceof PolybillError &&
            error.code === "conflict" &&
            error.operation === "resource.replace"
          )
            throw new PolybillError(
              "Subscription changed concurrently; reconcile before another mutation",
              {
                code: "outcome_unknown",
                operation: capability,
                provider: context.connection.provider,
                retryable: false,
              },
            );
          throw error;
        }
      },
    });
  }
}

function assertItems(items: Subscription["items"]): void {
  if (
    items.length === 0 ||
    new Set(items.map((item) => item.priceId)).size !== items.length ||
    items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)
  )
    throw new TypeError("Subscription items are invalid");
}

function sameItems(
  left: ProviderSubscriptionSnapshot["items"],
  right: ProviderSubscriptionSnapshot["items"],
): boolean {
  return (
    left.length === right.length &&
    left.every((item) =>
      right.some(
        (other) =>
          other.externalPriceId === item.externalPriceId && other.quantity === item.quantity,
      ),
    )
  );
}

function decodeSubscription(value: unknown): Subscription {
  if (typeof value !== "object" || value === null || !("id" in value) || !("items" in value))
    throw new TypeError("Stored subscription replay is invalid");
  return value as Subscription;
}

function unsupported(operation: string): PolybillError {
  return new PolybillError("Provider subscription capability is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}
