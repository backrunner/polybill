import {
  arrayField,
  object,
  stringField,
  type ProviderRefundSnapshot,
  type RefundProvider,
} from "@polybill/adapter-kit";
import { PolybillError, money, parseCurrency, type ConnectionId, type Money } from "@polybill/core";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleRefunds: RefundProvider = {
  async create(context, input) {
    const body =
      input.amount === undefined
        ? {
            action: "refund",
            type: "full",
            transaction_id: input.externalPaymentId,
            reason: input.reason ?? "Requested through Polybill",
          }
        : {
            action: "refund",
            type: "partial",
            transaction_id: input.externalPaymentId,
            reason: input.reason ?? "Requested through Polybill",
            tax_mode: "internal",
            items: await partialItems(context, input.externalPaymentId, input.amount),
          };
    return paddleResult(
      context,
      decode((await paddleRequest(context, "POST", "/adjustments", body)).json()),
    );
  },
  async get(context, externalId) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "GET", `/adjustments/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
};

async function partialItems(
  context: Parameters<NonNullable<RefundProvider["create"]>>[0],
  transactionId: string,
  amount: Money,
): Promise<
  readonly { readonly item_id: string; readonly type: "partial"; readonly amount: string }[]
> {
  const response = object(
    (
      await paddleRequest(context, "GET", `/transactions/${encodeURIComponent(transactionId)}`)
    ).json(),
    "paddle",
    "paddle.refund.transaction.decode",
  );
  const transaction = object(response.data, "paddle", "paddle.refund.transaction.decode");
  const currency = stringField(
    transaction,
    "currency_code",
    "paddle",
    "paddle.refund.transaction.decode",
  );
  if (currency.toUpperCase() !== amount.currency)
    throw invalid(context.connection.id, "Refund currency does not match the Paddle transaction");
  const details = object(transaction.details, "paddle", "paddle.refund.transaction.decode");
  const lines = arrayField(details, "line_items", "paddle", "paddle.refund.transaction.decode");
  let remaining = BigInt(amount.amount);
  const items: { item_id: string; type: "partial"; amount: string }[] = [];
  for (const value of lines) {
    if (remaining === 0n) break;
    const line = object(value, "paddle", "paddle.refund.transaction.decode");
    const totals = object(line.totals, "paddle", "paddle.refund.transaction.decode");
    const available = minor(
      stringField(totals, "total", "paddle", "paddle.refund.transaction.decode"),
    );
    const allocated = available < remaining ? available : remaining;
    if (allocated > 0n)
      items.push({
        item_id: stringField(line, "id", "paddle", "paddle.refund.transaction.decode"),
        type: "partial",
        amount: allocated.toString(),
      });
    remaining -= allocated;
  }
  if (remaining !== 0n)
    throw invalid(context.connection.id, "Refund exceeds transaction line totals");
  return items;
}

function decode(value: unknown): ProviderRefundSnapshot {
  const root = object(value, "paddle", "paddle.refund.decode");
  const data = object(root.data, "paddle", "paddle.refund.decode");
  const totals = object(data.totals, "paddle", "paddle.refund.decode");
  const rawStatus = stringField(data, "status", "paddle", "paddle.refund.decode");
  return {
    externalId: stringField(data, "id", "paddle", "paddle.refund.decode"),
    externalPaymentId: stringField(data, "transaction_id", "paddle", "paddle.refund.decode"),
    amount: money(
      minor(stringField(totals, "total", "paddle", "paddle.refund.decode")).toString(),
      parseCurrency(stringField(data, "currency_code", "paddle", "paddle.refund.decode")),
    ),
    status:
      rawStatus === "pending_approval"
        ? "pending"
        : rawStatus === "approved"
          ? "succeeded"
          : rawStatus === "rejected"
            ? "failed"
            : rawStatus === "reversed"
              ? "canceled"
              : "unknown",
    rawStatus,
  };
}

function minor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("Paddle amount is invalid");
  return BigInt(value);
}

function invalid(connectionId: ConnectionId, message: string): PolybillError {
  return new PolybillError(message, {
    code: "invalid_request",
    operation: "paddle.refund.create",
    provider: "paddle",
    connectionId,
    retryable: false,
  });
}
