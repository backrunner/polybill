import {
  PolybillError,
  assertSubscriptionItemChangePolicy,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type IdempotencyKey,
  type IsoDateTime,
  type Subscription,
  type SubscriptionId,
  type SubscriptionItemChangePolicy,
} from "@polybill/core";
import type { BillingRecord, BillingScope, BillingStore } from "./billing-store.js";
import { stableStringify } from "./checkout-helpers.js";
import type { ResourceRuntime } from "./resource-runtime.js";
import { SubscriptionService } from "./subscriptions.js";
import { decodeSchedule as decode, decodePhases } from "./subscription-schedule-codec.js";

export interface SubscriptionPhase {
  readonly executeAt: IsoDateTime;
  readonly latestAt: IsoDateTime;
  readonly items: Subscription["items"];
  readonly proration: SubscriptionItemChangePolicy["proration"];
}
export interface SubscriptionSchedule {
  readonly id: string;
  readonly subscriptionId: SubscriptionId;
  readonly phases: readonly SubscriptionPhase[];
  readonly phase: number;
  readonly expectedItems: Subscription["items"];
  readonly state: "preparing" | "pending" | "attempted" | "complete" | "needs_review" | "canceled";
  readonly reviewReason?: "late_or_changed" | "unconfirmed_attempt" | "ownership_conflict";
  readonly payloadHash: string;
  readonly strategy: "host_scheduled_item_changes";
  readonly warning: "Execution depends on the host scheduler; provider invoice timing and billing-anchor preservation are not guaranteed.";
}

export class SubscriptionScheduleService {
  readonly subscriptions: SubscriptionService;
  constructor(
    readonly runtime: ResourceRuntime,
    readonly store: BillingStore,
  ) {
    this.subscriptions = new SubscriptionService(runtime);
  }

  async create(command: {
    readonly subscriptionId: SubscriptionId;
    readonly phases: readonly SubscriptionPhase[];
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<SubscriptionSchedule> {
    parseIdempotencyKey(command.idempotencyKey);
    parseId<"SubscriptionId">(command.subscriptionId, "sub");
    const phases = decodePhases(command.phases);
    const id = `sched_${await this.#hash(command.idempotencyKey)}`;
    const payloadHash = await this.#hash(stableStringify({ ...command, phases }));
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    const existingRecord = await this.store.getBillingRecord(this.#scope(), "schedule", id);
    if (existingRecord !== undefined) {
      const existing = decode(existingRecord);
      if (existing.payloadHash !== payloadHash) throw failure("idempotency_conflict");
      return existing.state === "preparing" ? this.#activate(existingRecord) : existing;
    }
    const context = await this.runtime.context();
    await this.runtime.requireCapability("subscription.change_items", context);
    await this.runtime.requireCapability("subscription.read", context);
    if (command.phases.length < 1 || command.phases.length > 10)
      throw new TypeError("Schedules need one to ten phases");
    let previous = Date.parse(context.clock.now());
    for (const phase of phases) {
      parseIsoDateTime(phase.executeAt);
      parseIsoDateTime(phase.latestAt);
      if (
        Date.parse(phase.executeAt) <= previous ||
        Date.parse(phase.latestAt) < Date.parse(phase.executeAt)
      )
        throw new TypeError("Invalid schedule execution window");
      previous = Date.parse(phase.latestAt);
      assertSubscriptionItemChangePolicy({ timing: "immediately", proration: phase.proration });
      if (
        phase.items.length === 0 ||
        new Set(phase.items.map((item) => item.priceId)).size !== phase.items.length
      )
        throw new TypeError("Invalid phase items");
      for (const item of phase.items) {
        parseId<"PriceId">(item.priceId, "price");
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1)
          throw new TypeError("Invalid phase quantity");
        if (
          (await this.runtime.options.store.getExternalId(
            context.tenantId,
            context.connection.id,
            "price",
            item.priceId,
          )) === undefined
        )
          throw failure("invalid_request");
      }
    }
    const current = await this.#refresh(command.subscriptionId);
    if (
      !billable(current) ||
      current.scheduledChange !== undefined ||
      current.collectionPause !== undefined
    )
      throw failure("invalid_request");
    const value: SubscriptionSchedule = {
      id,
      subscriptionId: command.subscriptionId,
      phases,
      phase: 0,
      expectedItems: current.items,
      state: "preparing",
      payloadHash,
      strategy: "host_scheduled_item_changes",
      warning:
        "Execution depends on the host scheduler; provider invoice timing and billing-anchor preservation are not guaranteed.",
    };
    const record: BillingRecord = {
      kind: "schedule",
      id,
      version: 1,
      dueAt: context.clock.now(),
      value,
    };
    if (!(await this.store.putBillingRecord(this.#scope(), record, 0))) {
      const winner = await this.store.getBillingRecord(this.#scope(), "schedule", id);
      if (winner === undefined || decode(winner).payloadHash !== payloadHash)
        throw failure("idempotency_conflict");
      return decode(winner).state === "preparing" ? this.#activate(winner) : decode(winner);
    }
    return this.#activate(record);
  }

  async get(id: string): Promise<SubscriptionSchedule | undefined> {
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    const record = await this.store.getBillingRecord(this.#scope(), "schedule", id);
    return record === undefined ? undefined : decode(record);
  }

  async cancel(id: string): Promise<SubscriptionSchedule> {
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    const record = await this.store.getBillingRecord(this.#scope(), "schedule", id);
    if (record === undefined) throw failure("not_found");
    const current = decode(record);
    if (current.state === "attempted" || current.reviewReason === "unconfirmed_attempt")
      throw failure("outcome_unknown");
    if (current.state === "complete" || current.state === "canceled") return current;
    return this.#save(record, { ...current, state: "canceled" });
  }

  async runDue(limit = 50): Promise<
    readonly {
      readonly id: string;
      readonly schedule?: SubscriptionSchedule;
      readonly errorCode?: string;
    }[]
  > {
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    const records = await this.store.listDueBillingRecords(
      this.#scope(),
      "schedule",
      this.runtime.options.clock.now(),
      limit,
    );
    const result: { id: string; schedule?: SubscriptionSchedule; errorCode?: string }[] = [];
    for (const record of records) {
      try {
        result.push({ id: record.id, schedule: await this.#run(record) });
      } catch (error) {
        result.push({
          id: record.id,
          errorCode: error instanceof PolybillError ? error.code : "internal_error",
        });
      }
    }
    return result;
  }

  async reconcile(id: string): Promise<SubscriptionSchedule> {
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    const record = await this.store.getBillingRecord(this.#scope(), "schedule", id);
    if (record === undefined) throw failure("not_found");
    const value = decode(record);
    if (
      value.state !== "attempted" &&
      !(value.state === "needs_review" && value.reviewReason === "unconfirmed_attempt")
    )
      return value;
    const phase = value.phases[value.phase];
    const current = await this.#refresh(value.subscriptionId);
    if (phase !== undefined && billable(current) && sameItems(current.items, phase.items))
      return this.#advance(record, value, current);
    return value;
  }

  async #run(record: BillingRecord): Promise<SubscriptionSchedule> {
    const value = decode(record);
    if (value.state === "preparing") return this.#activate(record);
    const phase = value.phases[value.phase];
    if (phase === undefined || !["pending", "attempted"].includes(value.state))
      throw failure("invalid_request");
    const current = await this.#refresh(value.subscriptionId);
    if (value.state === "attempted") {
      if (sameItems(current.items, phase.items) && billable(current))
        return this.#advance(record, value, current);
      // The previous request might still arrive. Observation alone never authorizes another POST.
      return this.#save(record, {
        ...value,
        state: "needs_review",
        reviewReason: "unconfirmed_attempt",
      });
    }
    if (
      Date.parse(this.runtime.options.clock.now()) > Date.parse(phase.latestAt) ||
      !billable(current) ||
      current.scheduledChange !== undefined ||
      current.collectionPause !== undefined ||
      !sameItems(current.items, value.expectedItems)
    )
      return this.#save(record, {
        ...value,
        state: "needs_review",
        reviewReason: "late_or_changed",
      });
    if (sameItems(current.items, phase.items)) return this.#advance(record, value, current);
    const attempted = { ...value, state: "attempted" as const };
    const claimed: BillingRecord = { ...record, version: record.version + 1, value: attempted };
    if (!(await this.store.putBillingRecord(this.#scope(), claimed, record.version)))
      throw failure("conflict");
    const key = parseIdempotencyKey(`${value.id}:${value.phase}`);
    // The attempted record survives transport failure, process death, and a lost store response.
    const changed = await this.subscriptions.changeItems(value.subscriptionId, key, phase.items, {
      timing: "immediately",
      proration: phase.proration,
    });
    return this.#advance(claimed, attempted, changed);
  }

  #advance(record: BillingRecord, value: SubscriptionSchedule, current: Subscription) {
    const phase = value.phase + 1;
    const rest = { ...value };
    delete rest.reviewReason;
    return this.#save(record, {
      ...rest,
      phase,
      expectedItems: current.items,
      state: phase === value.phases.length ? "complete" : "pending",
    });
  }
  async #save(record: BillingRecord, value: SubscriptionSchedule) {
    const dueAt = value.state === "pending" ? value.phases[value.phase]?.executeAt : undefined;
    if (
      !(await this.store.putBillingRecord(
        this.#scope(),
        {
          kind: "schedule",
          id: record.id,
          version: record.version + 1,
          ...(dueAt === undefined ? {} : { dueAt }),
          value,
        },
        record.version,
      ))
    )
      throw failure("conflict");
    return value;
  }
  #refresh(id: SubscriptionId) {
    return this.subscriptions.refresh(
      id,
      parseIdempotencyKey(`schedule-read:${this.runtime.options.ids.next("req")}`),
    );
  }
  #scope(): BillingScope {
    const { tenantId, connection } = this.runtime.options;
    return { tenantId, connectionId: connection.id, environment: connection.environment };
  }
  #hash(value: string) {
    return this.runtime.options.crypto.sha256(new TextEncoder().encode(value));
  }

  async #activate(record: BillingRecord): Promise<SubscriptionSchedule> {
    const value = decode(record);
    try {
      await this.#own(value.subscriptionId, value.id);
    } catch (error) {
      if (error instanceof PolybillError && error.code === "conflict")
        await this.#save(record, {
          ...value,
          state: "needs_review",
          reviewReason: "ownership_conflict",
        });
      throw error;
    }
    return this.#save(record, { ...value, state: "pending" });
  }

  async #own(subscriptionId: SubscriptionId, scheduleId: string): Promise<void> {
    const owner = await this.store.getBillingRecord(
      this.#scope(),
      "schedule_owner",
      subscriptionId,
    );
    if (owner !== undefined) {
      if (typeof owner.value !== "string") throw failure("invalid_request");
      if (owner.value === scheduleId) return;
      const schedule = await this.get(owner.value);
      // Missing state may be an in-flight creation, so never steal its claim.
      if (
        schedule === undefined ||
        (schedule.state !== "complete" && schedule.state !== "canceled")
      )
        throw failure("conflict");
    }
    if (
      !(await this.store.putBillingRecord(
        this.#scope(),
        {
          kind: "schedule_owner",
          id: subscriptionId,
          version: (owner?.version ?? 0) + 1,
          value: scheduleId,
        },
        owner?.version ?? 0,
      ))
    ) {
      const winner = await this.store.getBillingRecord(
        this.#scope(),
        "schedule_owner",
        subscriptionId,
      );
      if (winner?.value !== scheduleId) throw failure("conflict");
    }
  }
}

function billable(value: Subscription) {
  return value.status === "active" || value.status === "trialing";
}
function sameItems(left: Subscription["items"], right: Subscription["items"]) {
  return (
    left.length === right.length &&
    left.every((item) =>
      right.some((other) => other.priceId === item.priceId && other.quantity === item.quantity),
    )
  );
}
function failure(
  code: "idempotency_conflict" | "invalid_request" | "not_found" | "conflict" | "outcome_unknown",
) {
  return new PolybillError("Subscription schedule cannot be applied in its current state", {
    code,
    operation: "subscription.schedule",
    retryable: code === "conflict",
  });
}
