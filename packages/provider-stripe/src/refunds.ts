import {
  object,
  stringField,
  type ProviderRefundSnapshot,
  type RefundProvider,
} from "@polybill/adapter-kit";
import { money, parseCurrency } from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeRefunds: RefundProvider = {
  async create(context, input) {
    const body = new URLSearchParams({ payment_intent: input.externalPaymentId });
    if (input.amount !== undefined) body.set("amount", input.amount.amount);
    if (
      input.reason !== undefined &&
      ["duplicate", "fraudulent", "requested_by_customer"].includes(input.reason)
    )
      body.set("reason", input.reason);
    for (const [key, value] of Object.entries(input.metadata)) body.set(`metadata[${key}]`, value);
    return stripeResult(
      context,
      decodeRefund((await stripeRequest(context, "POST", "/v1/refunds", body)).json()),
    );
  },
  async get(context, externalId) {
    return stripeResult(
      context,
      decodeRefund(
        (
          await stripeRequest(context, "GET", `/v1/refunds/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
};

function decodeRefund(value: unknown): ProviderRefundSnapshot {
  const root = object(value, "stripe", "stripe.refund.decode");
  const amount = root.amount;
  if (!Number.isSafeInteger(amount) || Number(amount) < 0)
    throw new TypeError("Stripe refund amount is invalid");
  const rawStatus = stringField(root, "status", "stripe", "stripe.refund.decode");
  return {
    externalId: stringField(root, "id", "stripe", "stripe.refund.decode"),
    externalPaymentId: stringField(root, "payment_intent", "stripe", "stripe.refund.decode"),
    amount: money(
      String(amount),
      parseCurrency(stringField(root, "currency", "stripe", "stripe.refund.decode").toUpperCase()),
    ),
    status:
      rawStatus === "pending" ||
      rawStatus === "succeeded" ||
      rawStatus === "failed" ||
      rawStatus === "canceled"
        ? rawStatus
        : "unknown",
    rawStatus,
  };
}
