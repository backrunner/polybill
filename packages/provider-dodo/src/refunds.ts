import {
  object,
  optionalString,
  stringField,
  type ProviderRefundSnapshot,
  type RefundProvider,
} from "@polybill/adapter-kit";
import { PolybillError, money, parseCurrency } from "@polybill/core";
import { dodoRequest } from "./client.js";
import { dodoResult } from "./result.js";

export const dodoRefunds: RefundProvider = {
  async create(context, input) {
    if (input.amount !== undefined)
      throw new PolybillError("Dodo partial refunds require provider item IDs", {
        code: "unsupported_capability",
        operation: "dodo.refund.create",
        provider: "dodo",
        connectionId: context.connection.id,
        retryable: false,
      });
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "POST", "/refunds", {
            payment_id: input.externalPaymentId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            metadata: input.metadata,
          })
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    return dodoResult(
      context,
      decode(
        (await dodoRequest(context, "GET", `/refunds/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
};

function decode(value: unknown): ProviderRefundSnapshot {
  const root = object(value, "dodo", "dodo.refund.decode");
  const amount = root.amount;
  const currency = optionalString(root, "currency");
  if (!Number.isSafeInteger(amount) || Number(amount) < 0 || currency === undefined)
    throw new TypeError("Dodo refund response has no authoritative amount and currency");
  const rawStatus = stringField(root, "status", "dodo", "dodo.refund.decode");
  return {
    externalId: stringField(root, "refund_id", "dodo", "dodo.refund.decode"),
    externalPaymentId: stringField(root, "payment_id", "dodo", "dodo.refund.decode"),
    amount: money(String(amount), parseCurrency(currency.toUpperCase())),
    status:
      rawStatus === "succeeded" || rawStatus === "failed" || rawStatus === "pending"
        ? rawStatus
        : "unknown",
    rawStatus,
  };
}
