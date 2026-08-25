import {
  object,
  stringField,
  type ProviderRefundSnapshot,
  type RefundProvider,
} from "@polybill/adapter-kit";
import { PolybillError, money, parseCurrency } from "@polybill/core";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleRefunds: RefundProvider = {
  async create(context, input) {
    if (input.amount !== undefined)
      throw new PolybillError("Paddle Billing supports full refunds only", {
        code: "unsupported_capability",
        operation: "refund.partial",
        provider: "paddle",
        connectionId: context.connection.id,
        retryable: false,
      });
    const body = {
      action: "refund",
      type: "full",
      transaction_id: input.externalPaymentId,
      reason: input.reason ?? "Requested through Polybill",
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
