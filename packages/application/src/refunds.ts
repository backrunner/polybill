import {
  PolybillError,
  parseId,
  type IdempotencyKey,
  type Money,
  type PaymentId,
  type Refund,
} from "@polybill/core";
import { requireExternalId } from "./resource-runtime.js";
import type { ResourceRuntime } from "./resource-runtime.js";

export interface CreateRefundCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly paymentId: PaymentId;
  readonly amount?: Money;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class RefundService {
  readonly #runtime: ResourceRuntime;
  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async create(command: CreateRefundCommand): Promise<Refund> {
    return this.#runtime.mutate({
      operation: "refund.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeRefund,
      execute: async (context) => {
        const key = command.amount === undefined ? "refund.full" : "refund.partial";
        await this.#runtime.requireCapability(key, context);
        const port = this.#runtime.options.adapter.refunds?.create;
        if (port === undefined) throw unsupported();
        const externalPaymentId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "payment",
            command.paymentId,
          ),
          "refund.create",
        );
        const remote = await port(context, {
          externalPaymentId,
          ...(command.amount === undefined ? {} : { amount: command.amount }),
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          metadata: command.metadata ?? {},
        });
        if (remote.value.status === "unknown")
          throw new PolybillError("Provider returned an unknown refund status", {
            code: "provider_response_invalid",
            operation: "refund.decode",
            retryable: false,
          });
        const refund: Refund = {
          id: parseId<"RefundId">(this.#runtime.options.ids.next("ref"), "ref"),
          paymentId: command.paymentId,
          amount: remote.value.amount,
          status: remote.value.status,
          evidence: [],
        };
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "refund",
          entityId: refund.id,
          externalId: remote.value.externalId,
          value: refund,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return refund;
      },
    });
  }
  get(id: Refund["id"]): Promise<Refund | undefined> {
    return this.#runtime.options.store.getResource(this.#runtime.options.tenantId, "refund", id);
  }

  async refresh(id: Refund["id"], idempotencyKey: IdempotencyKey): Promise<Refund> {
    const current = await this.get(id);
    if (current === undefined)
      throw new PolybillError("Canonical refund was not found", {
        code: "not_found",
        operation: "refund.refresh",
        retryable: false,
      });
    return this.#runtime.mutate({
      operation: "refund.refresh",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeRefund,
      execute: async (context) => {
        const port = this.#runtime.options.adapter.refunds?.get;
        if (port === undefined) throw unsupported();
        const externalId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "refund",
            id,
          ),
          "refund.refresh",
        );
        const remote = await port(context, externalId);
        if (remote.value.status === "unknown")
          throw new PolybillError("Provider returned an unknown refund status", {
            code: "provider_response_invalid",
            operation: "refund.refresh",
            retryable: false,
          });
        const refund: Refund = {
          ...current,
          amount: remote.value.amount,
          status: remote.value.status,
        };
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "refund",
          entityId: id,
          externalId,
          value: refund,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return refund;
      },
    });
  }
}
function decodeRefund(value: unknown): Refund {
  if (typeof value !== "object" || value === null || !("id" in value) || !("amount" in value))
    throw new TypeError("Stored refund replay is invalid");
  return value as Refund;
}
function unsupported() {
  return new PolybillError("Provider refund capability is unavailable", {
    code: "unsupported_capability",
    operation: "refund.create",
    retryable: false,
  });
}
