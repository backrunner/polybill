import {
  object,
  optionalString,
  providerIntegerAmount,
  stringField,
  type CheckoutProvider,
  type ProviderCheckoutCommand,
  type ProviderCheckoutSnapshot,
  type ProviderContext,
  type ProviderOperationResult,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { dodoRequest } from "./client.js";

export const dodoCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    const value = decodeStatus(
      (await dodoRequest(context, "GET", `/checkouts/${encodeURIComponent(externalId)}`)).json(),
    );
    if (value.externalId !== externalId) throw new TypeError("Dodo checkout ID mismatch");
    if (value.status !== "complete" || value.externalPaymentId === undefined)
      return result(context, value);
    const payment = object(
      (
        await dodoRequest(
          context,
          "GET",
          `/payments/${encodeURIComponent(value.externalPaymentId)}`,
        )
      ).json(),
      "dodo",
      "dodo.checkout.payment",
    );
    if (
      payment.payment_id !== value.externalPaymentId ||
      payment.checkout_session_id !== externalId
    )
      throw new TypeError("Dodo payment does not belong to this checkout");
    const ids: unknown =
      payment.subscription_ids ??
      (typeof payment.subscription_id === "string" ? [payment.subscription_id] : []);
    if (
      !Array.isArray(ids) ||
      ids.some((id: unknown) => typeof id !== "string" || id.length === 0) ||
      new Set(ids).size !== ids.length
    )
      throw new TypeError("Dodo subscription references are invalid");
    return result(context, { ...value, externalSubscriptionIds: ids as string[] });
  },
};

async function create(
  context: ProviderContext,
  command: ProviderCheckoutCommand,
): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>> {
  const productCart = command.lines.map((line) => {
    if (line.externalPriceId === undefined)
      throw new PolybillError("Dodo checkout requires a mapped catalog product", {
        code: "unsupported_capability",
        operation: "dodo.checkout.create",
        provider: "dodo",
        connectionId: context.connection.id,
        retryable: false,
      });
    return {
      product_id: line.externalPriceId,
      quantity: line.quantity,
      ...(line.price.kind === "custom"
        ? { amount: providerIntegerAmount(line.unitAmount.amount, "dodo") }
        : {}),
    };
  });
  const response = await dodoRequest(context, "POST", "/checkouts", {
    product_cart: productCart,
    return_url: command.successUrl,
    cancel_url: command.cancelUrl,
    metadata: { ...command.metadata, polybill_order_id: command.orderId },
    ...(command.externalCustomerId !== undefined
      ? { customer: { customer_id: command.externalCustomerId } }
      : command.customerEmail === undefined
        ? {}
        : { customer: { email: command.customerEmail } }),
  });
  const root = object(response.json(), "dodo", "dodo.checkout.decode");
  const url = optionalString(root, "checkout_url");
  const externalPaymentId = optionalString(root, "payment_id");
  const value: ProviderCheckoutSnapshot = {
    externalId: stringField(root, "session_id", "dodo", "dodo.checkout.decode"),
    ...(externalPaymentId === undefined ? {} : { externalPaymentId }),
    status: "open",
    ...(url === undefined ? {} : { url }),
    rawStatus: "created",
  };
  return result(context, value);
}

function decodeStatus(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "dodo", "dodo.checkout.decode");
  const rawStatus = optionalString(root, "payment_status") ?? "collecting_details";
  const externalPaymentId = optionalString(root, "payment_id");
  const status =
    rawStatus === "succeeded"
      ? "complete"
      : rawStatus === "failed" || rawStatus === "cancelled"
        ? "canceled"
        : [
              "collecting_details",
              "processing",
              "requires_payment_method",
              "requires_confirmation",
              "requires_customer_action",
            ].includes(rawStatus)
          ? "open"
          : "unknown";
  return {
    externalId: stringField(root, "id", "dodo", "dodo.checkout.decode"),
    ...(externalPaymentId === undefined ? {} : { externalPaymentId }),
    status,
    rawStatus,
  };
}

function result(
  context: ProviderContext,
  value: ProviderCheckoutSnapshot,
): ProviderOperationResult<ProviderCheckoutSnapshot> {
  return {
    value,
    evidence: {
      provider: "dodo",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "polybill",
    warnings: [],
  };
}
