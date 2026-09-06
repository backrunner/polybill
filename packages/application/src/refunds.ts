import {
  PolybillError,
  addMoney,
  compareMoney,
  parseId,
  type IdempotencyKey,
  type Money,
  type Order,
  type Payment,
  type PaymentId,
  type Refund,
  subtractMoney,
} from "@polybill/core";
import { requireExternalId } from "./resource-runtime.js";
import type { ResourceRuntime } from "./resource-runtime.js";
import type { ResourceCommit } from "./ports.js";

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
        const payment = await this.#runtime.options.store.getResource<Payment>(
          this.#runtime.options.tenantId,
          "payment",
          command.paymentId,
        );
        if (payment === undefined) throw missingPayment("refund.create", command.paymentId);
        const remaining = subtractMoney(payment.amount, payment.refundedAmount);
        if (compareMoney(remaining, moneyZero(payment.amount)) === 0)
          throw refundInvalid("Payment has no refundable balance", "refund.create");
        if (
          command.amount !== undefined &&
          (command.amount.currency !== payment.amount.currency ||
            BigInt(command.amount.amount) <= 0 ||
            BigInt(command.amount.amount) > BigInt(remaining.amount))
        )
          throw new PolybillError(
            "Refund amount must match the payment currency and remaining balance",
            {
              code: "invalid_request",
              operation: "refund.create",
              retryable: false,
            },
          );
        const remote = await port(context, {
          externalPaymentId,
          ...(command.amount === undefined ? {} : { amount: command.amount }),
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          metadata: command.metadata ?? {},
        });
        if (remote.value.externalPaymentId !== externalPaymentId)
          throw refundInvalid("Provider refund belongs to a different payment", "refund.decode");
        if (remote.value.status === "unknown")
          throw new PolybillError("Provider returned an unknown refund status", {
            code: "provider_response_invalid",
            operation: "refund.decode",
            retryable: false,
          });
        validateRemoteAmount(
          remote.value.amount,
          payment,
          command.amount,
          remaining,
          remote.value.status,
        );
        if (
          command.amount === undefined &&
          (remote.value.status === "pending" || remote.value.status === "succeeded") &&
          compareMoney(remote.value.amount, remaining) !== 0
        )
          throw refundInvalid(
            "Provider full refund amount does not cover the remaining payment balance",
            "refund.decode",
          );
        const refund: Refund = {
          id: parseId<"RefundId">(this.#runtime.options.ids.next("ref"), "ref"),
          paymentId: command.paymentId,
          amount: remote.value.amount,
          status: remote.value.status,
          evidence: [],
        };
        const commits: ResourceCommit[] = [
          {
            tenantId: this.#runtime.options.tenantId,
            connectionId: this.#runtime.options.connection.id,
            provider: this.#runtime.options.connection.provider,
            entityType: "refund",
            entityId: refund.id,
            externalId: remote.value.externalId,
            value: refund,
            evidence: remote.evidence,
            occurredAt: this.#runtime.options.clock.now(),
          },
        ];
        commits.push(
          ...(await this.#projectPaymentCommits(payment, undefined, refund, remote.evidence)),
        );
        await this.#commitAfterRemote(commits, "refund.commit");
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
        const expectedPaymentId = await this.#runtime.options.store.getExternalId(
          this.#runtime.options.tenantId,
          this.#runtime.options.connection.id,
          "payment",
          current.paymentId,
        );
        if (
          remote.value.externalId !== externalId ||
          remote.value.externalPaymentId !== expectedPaymentId
        )
          throw refundInvalid(
            "Provider refund identity does not match its mapping",
            "refund.refresh",
          );
        if (remote.value.status === "unknown")
          throw new PolybillError("Provider returned an unknown refund status", {
            code: "provider_response_invalid",
            operation: "refund.refresh",
            retryable: false,
          });
        const payment = await this.#runtime.options.store.getResource<Payment>(
          this.#runtime.options.tenantId,
          "payment",
          current.paymentId,
        );
        if (payment === undefined) throw missingPayment("refund.refresh", current.paymentId);
        const remainingBefore = addMoney(
          subtractMoney(payment.amount, payment.refundedAmount),
          current.status === "succeeded" ? current.amount : moneyZero(payment.amount),
        );
        validateRemoteAmount(
          remote.value.amount,
          payment,
          undefined,
          remainingBefore,
          remote.value.status,
        );
        const refund: Refund = {
          ...current,
          amount: remote.value.amount,
          status: remote.value.status,
        };
        const commits: ResourceCommit[] = [
          {
            tenantId: this.#runtime.options.tenantId,
            connectionId: this.#runtime.options.connection.id,
            provider: this.#runtime.options.connection.provider,
            entityType: "refund",
            entityId: id,
            externalId,
            value: refund,
            evidence: remote.evidence,
            occurredAt: this.#runtime.options.clock.now(),
          },
        ];
        commits.push(
          ...(await this.#projectPaymentCommits(payment, current, refund, remote.evidence)),
        );
        await this.#commitAfterRemote(commits, "refund.refresh.commit");
        return refund;
      },
    });
  }

  async #projectPaymentCommits(
    payment: Payment,
    previous: Refund | undefined,
    next: Refund,
    evidence: unknown,
  ): Promise<readonly ResourceCommit[]> {
    const before = previous?.status === "succeeded" ? previous.amount : moneyZero(payment.amount);
    const after = next.status === "succeeded" ? next.amount : moneyZero(payment.amount);
    const base = subtractMoney(payment.refundedAmount, before);
    const refundedAmount = addMoney(base, after);
    const projected: Payment = { ...payment, refundedAmount };
    const commits: ResourceCommit[] = [
      {
        tenantId: this.#runtime.options.tenantId,
        connectionId: this.#runtime.options.connection.id,
        provider: this.#runtime.options.connection.provider,
        entityType: "payment",
        entityId: payment.id,
        value: projected,
        evidence,
        occurredAt: this.#runtime.options.clock.now(),
      },
    ];
    const order = await this.#runtime.options.store.getResource<Order>(
      this.#runtime.options.tenantId,
      "order",
      payment.orderId,
    );
    if (order === undefined) {
      return commits;
    }
    const paymentStatus =
      compareMoney(refundedAmount, payment.amount) === 0
        ? "refunded"
        : compareMoney(refundedAmount, moneyZero(payment.amount)) > 0
          ? "partially_refunded"
          : order.paymentStatus;
    if (paymentStatus === order.paymentStatus) {
      return commits;
    }
    commits.push({
      tenantId: this.#runtime.options.tenantId,
      connectionId: this.#runtime.options.connection.id,
      provider: this.#runtime.options.connection.provider,
      entityType: "order",
      entityId: order.id,
      value: { ...order, paymentStatus },
      evidence,
      occurredAt: this.#runtime.options.clock.now(),
    });
    return commits;
  }

  async #commitAfterRemote(commits: readonly ResourceCommit[], operation: string): Promise<void> {
    try {
      await this.#runtime.options.store.commitResources(commits);
    } catch (cause) {
      throw new PolybillError("Refund was accepted but canonical persistence failed", {
        code: "outcome_unknown",
        operation,
        provider: this.#runtime.options.connection.provider,
        connectionId: this.#runtime.options.connection.id,
        retryable: true,
        cause,
      });
    }
  }
}

function validateRemoteAmount(
  remote: Money,
  payment: Payment,
  requested: Money | undefined,
  remaining: Money,
  status: "pending" | "succeeded" | "failed" | "canceled",
): void {
  if (remote.currency !== payment.amount.currency)
    throw refundInvalid("Provider refund currency does not match payment", "refund.decode");
  if (
    compareMoney(remote, moneyZero(payment.amount)) === 0 &&
    (status === "pending" || status === "succeeded")
  )
    throw refundInvalid("Provider returned a zero refund amount", "refund.decode");
  if (compareMoney(remote, remaining) > 0)
    throw refundInvalid("Provider refund exceeds the remaining payment balance", "refund.decode");
  if (requested !== undefined) {
    if (requested.currency !== payment.amount.currency || compareMoney(remote, requested) !== 0)
      throw refundInvalid(
        "Provider refund amount does not match the requested amount",
        "refund.decode",
      );
  }
}

function moneyZero(value: Money): Money {
  return { amount: "0" as Money["amount"], currency: value.currency };
}

function missingPayment(operation: string, paymentId: PaymentId): PolybillError {
  return new PolybillError(`Canonical payment ${paymentId} was not found`, {
    code: "not_found",
    operation,
    retryable: false,
  });
}

function refundInvalid(message: string, operation: string): PolybillError {
  return new PolybillError(message, {
    code: "provider_response_invalid",
    operation,
    retryable: false,
  });
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
