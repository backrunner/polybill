import type { ProviderUsageEvent } from "@polybill/adapter-kit";
import {
  PolybillError,
  parseUsageEvent,
  parseUsageMeter,
  parseIsoDateTime,
  type IdempotencyKey,
  type UsageEvent,
  type UsageMeter,
  type UsageReceipt,
} from "@polybill/core";
import type { BillingRecord, BillingScope, BillingStore } from "./billing-store.js";
import { stableStringify } from "./checkout-helpers.js";
import type { ResourceRuntime } from "./resource-runtime.js";
import { subscriptionMapping } from "./subscription-snapshot.js";

interface StoredUsage {
  readonly payloadHash: string;
  readonly event: UsageEvent;
  readonly remote: ProviderUsageEvent;
  readonly status: UsageReceipt["status"];
}

export class UsageService {
  constructor(
    readonly runtime: ResourceRuntime,
    readonly store: BillingStore,
  ) {}

  async createMeter(
    command: Omit<UsageMeter, "id"> & { readonly idempotencyKey: IdempotencyKey },
  ): Promise<UsageMeter> {
    parseUsageMeter({ ...command, id: "meter_validation" });
    return this.runtime.mutate({
      operation: "usage.meter",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: parseUsageMeter,
      execute: async (context) => {
        await this.runtime.requireCapability("usage.meter", context);
        const port = this.runtime.options.adapter.usage;
        if (port === undefined) throw failure("unsupported_capability");
        const meter = parseUsageMeter({ ...command, id: this.runtime.options.ids.next("meter") });
        const remote = await port.createMeter(context, meter);
        await this.runtime.options.store.insertResource({
          tenantId: context.tenantId,
          connectionId: context.connection.id,
          provider: context.connection.provider,
          entityType: "meter",
          entityId: meter.id,
          externalId: remote.value.externalId,
          value: meter,
          evidence: remote.evidence,
          occurredAt: context.clock.now(),
        });
        return meter;
      },
    });
  }

  async ingest(input: UsageEvent): Promise<UsageReceipt> {
    const event = parseUsageEvent(input);
    const context = await this.runtime.context();
    await this.runtime.requireCapability("usage.ingest", context);
    const port = this.runtime.options.adapter.usage;
    if (port === undefined) throw failure("unsupported_capability");
    const payloadHash = await this.#hash(stableStringify(event));
    const existing = await this.store.getBillingRecord(this.#scope(), "usage", event.id);
    if (existing !== undefined) return this.#recover(existing, payloadHash);
    const stored = await this.runtime.options.store.getResource<unknown>(
      context.tenantId,
      "meter",
      event.meterId,
    );
    if (stored === undefined) throw failure("invalid_request");
    const meter = parseUsageMeter(stored);
    if (meter.id !== event.meterId || (meter.aggregation === "count" && event.quantity !== "1"))
      throw failure("invalid_request");
    await subscriptionMapping(this.runtime, "meter", event.meterId);
    const externalCustomerId = await subscriptionMapping(
      this.runtime,
      "customer",
      event.customerId,
    );
    const remote: ProviderUsageEvent = {
      externalId: `polybill_${await this.#hash(stableStringify({ ...this.#scope(), id: event.id }))}`,
      externalCustomerId,
      meter,
      quantity: event.quantity,
      occurredAt: event.occurredAt,
    };
    const value: StoredUsage = { event, remote, payloadHash, status: "outcome_unknown" };
    port.validateEvent?.(context, remote);
    const record: BillingRecord = { kind: "usage", id: event.id, version: 1, value };
    // This CAS is the durable mutation claim. A losing caller cannot send the event.
    if (!(await this.store.putBillingRecord(this.#scope(), record, 0))) {
      const winner = await this.store.getBillingRecord(this.#scope(), "usage", event.id);
      if (winner === undefined) throw failure("conflict");
      return this.#recover(winner, payloadHash);
    }
    await port.ingest(context, remote);
    return this.#accepted(record, value);
  }

  async #recover(record: BillingRecord, payloadHash: string): Promise<UsageReceipt> {
    const value = decode(record);
    if (value.payloadHash !== payloadHash) throw failure("idempotency_conflict");
    if (value.status === "accepted") return { event: value.event, status: "accepted" };
    const context = await this.runtime.context();
    const find = this.runtime.options.adapter.usage?.findEvent;
    if (find !== undefined && (await find(context, value.remote)))
      return this.#accepted(record, value);
    return { event: value.event, status: "outcome_unknown" };
  }
  async #accepted(record: BillingRecord, value: StoredUsage): Promise<UsageReceipt> {
    if (
      !(await this.store.putBillingRecord(
        this.#scope(),
        { ...record, version: record.version + 1, value: { ...value, status: "accepted" } },
        record.version,
      ))
    ) {
      const winner = await this.store.getBillingRecord(this.#scope(), "usage", record.id);
      if (
        winner === undefined ||
        decode(winner).status !== "accepted" ||
        decode(winner).payloadHash !== value.payloadHash
      )
        throw failure("conflict");
    }
    return { event: value.event, status: "accepted" };
  }
  #scope(): BillingScope {
    const { tenantId, connection } = this.runtime.options;
    return { tenantId, connectionId: connection.id, environment: connection.environment };
  }
  #hash(value: string) {
    return this.runtime.options.crypto.sha256(new TextEncoder().encode(value));
  }
}

function decode(record: BillingRecord): StoredUsage {
  const value = record.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("payloadHash" in value) ||
    typeof value.payloadHash !== "string" ||
    !("event" in value) ||
    !("remote" in value) ||
    typeof value.remote !== "object" ||
    value.remote === null ||
    !("status" in value) ||
    (value.status !== "accepted" && value.status !== "outcome_unknown")
  )
    throw new TypeError("Invalid stored usage event");
  const event = parseUsageEvent(value.event);
  const input = value.remote;
  if (
    !("externalId" in input) ||
    typeof input.externalId !== "string" ||
    input.externalId.length === 0 ||
    !("externalCustomerId" in input) ||
    typeof input.externalCustomerId !== "string" ||
    input.externalCustomerId.length === 0 ||
    !("meter" in input) ||
    !("quantity" in input) ||
    input.quantity !== event.quantity ||
    !("occurredAt" in input) ||
    typeof input.occurredAt !== "string" ||
    parseIsoDateTime(input.occurredAt) !== event.occurredAt ||
    event.id !== record.id
  )
    throw new TypeError("Invalid stored usage binding");
  const meter = parseUsageMeter(input.meter);
  if (meter.id !== event.meterId || (meter.aggregation === "count" && event.quantity !== "1"))
    throw new TypeError("Invalid stored usage meter");
  return {
    payloadHash: value.payloadHash,
    event,
    status: value.status,
    remote: {
      externalId: input.externalId,
      externalCustomerId: input.externalCustomerId,
      meter,
      quantity: event.quantity,
      occurredAt: event.occurredAt,
    },
  };
}
function failure(
  code: "unsupported_capability" | "invalid_request" | "conflict" | "idempotency_conflict",
) {
  return new PolybillError("Usage operation cannot be applied", {
    code,
    operation: "usage.ingest",
    retryable: code === "conflict",
  });
}
