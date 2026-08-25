import type { ProviderCheckoutSnapshot, ProviderOperationResult } from "@polybill/adapter-kit";
import {
  PolybillError,
  money,
  multiplyMoney,
  parseId,
  transitionPayment,
  type CheckoutSession,
  type Order,
  type Payment,
} from "@polybill/core";
import type { CheckoutServiceOptions, CreateCheckoutResult } from "./checkout.js";
import type { StoredPreparedCheckout } from "./checkout-helpers.js";
import type { IdempotencyScope } from "./ports.js";

export async function commitRemoteCheckout(
  options: CheckoutServiceOptions,
  scope: IdempotencyScope,
  leaseToken: string,
  prepared: StoredPreparedCheckout,
  remote: ProviderOperationResult<ProviderCheckoutSnapshot>,
): Promise<CreateCheckoutResult> {
  if (
    prepared.discountReservationId !== undefined &&
    (remote.value.total === undefined ||
      remote.value.total.currency !== prepared.providerCommand.total.currency ||
      remote.value.total.amount !== prepared.providerCommand.total.amount)
  )
    throw new PolybillError("Provider checkout total does not match the canonical discount quote", {
      code: "outcome_unknown",
      operation: "checkout.verify_discount_total",
      provider: options.connection.provider,
      connectionId: options.connection.id,
      retryable: true,
    });
  const result = toCheckoutResult(options, prepared, remote.value, remote.warnings);
  await options.store.commitCheckout({
    tenantId: options.tenantId,
    connectionId: options.connection.id,
    provider: options.connection.provider,
    externalCheckoutId: remote.value.externalId,
    ...(remote.value.externalPaymentId === undefined
      ? {}
      : { externalPaymentId: remote.value.externalPaymentId }),
    checkout: result.checkout,
    order: result.order,
    payment: result.payment,
    evidenceId: prepared.evidenceId ?? parseId<"EvidenceId">(options.ids.next("evi"), "evi"),
    evidence: remote.evidence,
    occurredAt: options.clock.now(),
    ...(prepared.discountReservationId === undefined
      ? {}
      : { discountReservationId: prepared.discountReservationId }),
  });
  await options.store.complete(scope, leaseToken, result);
  return result;
}

function toCheckoutResult(
  options: CheckoutServiceOptions,
  prepared: StoredPreparedCheckout,
  remote: ProviderCheckoutSnapshot,
  warnings: CreateCheckoutResult["warnings"],
): CreateCheckoutResult {
  const now = options.clock.now();
  const checkout: CheckoutSession = {
    id: prepared.checkoutId,
    orderId: prepared.orderId,
    status:
      remote.status === "complete"
        ? "complete"
        : remote.status === "expired"
          ? "expired"
          : remote.status === "canceled"
            ? "canceled"
            : "open",
    ...(remote.url === undefined ? {} : { url: remote.url }),
    ...(remote.expiresAt === undefined ? {} : { expiresAt: remote.expiresAt }),
  };
  const order: Order = {
    id: prepared.orderId,
    ...(prepared.providerCommand.customerId === undefined
      ? {}
      : { customerId: prepared.providerCommand.customerId }),
    lines: prepared.lines.map((line) => ({
      skuId: line.skuId,
      price: line.price,
      quantity: line.quantity,
      subtotal: multiplyMoney(line.unitAmount, line.quantity),
    })),
    grossTotal: prepared.providerCommand.grossTotal,
    discounts:
      prepared.providerCommand.discount === undefined
        ? []
        : [
            {
              discountId: prepared.providerCommand.discount.discountId,
              code: prepared.providerCommand.discount.code,
              amount: prepared.providerCommand.discount.amount,
            },
          ],
    discountTotal:
      prepared.providerCommand.discount?.amount ??
      money("0", prepared.providerCommand.grossTotal.currency),
    total: prepared.providerCommand.total,
    paymentStatus: "pending",
    fulfillmentStatus: "unfulfilled",
    commercialTermsRef:
      prepared.commercialTermsRef ?? parseId<"EvidenceId">(options.ids.next("evi"), "evi"),
    createdAt: now,
  };
  const pending: Payment = {
    id: prepared.paymentId,
    orderId: prepared.orderId,
    status: "pending",
    amount: prepared.providerCommand.total,
    refundedAmount: money("0", prepared.providerCommand.total.currency),
    evidence: [],
  };
  return {
    checkout,
    order,
    payment: remote.status === "complete" ? transitionPayment(pending, "succeeded") : pending,
    provider: options.connection.provider,
    warnings,
  };
}
