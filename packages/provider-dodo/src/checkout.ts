import {
  object,
  optionalString,
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
    return result(
      context,
      decodeStatus(
        (await dodoRequest(context, "GET", `/checkouts/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
  async recoverByIdempotencyKey(context, _key, command) {
    return create(context, command);
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
      ...(line.price.kind === "custom" ? { amount: line.unitAmount.amount } : {}),
    };
  });
  const response = await dodoRequest(context, "POST", "/checkouts", {
    product_cart: productCart,
    return_url: command.successUrl,
    cancel_url: command.cancelUrl,
    metadata: { ...command.metadata, polybill_order_id: command.orderId },
    ...(command.customerEmail === undefined ? {} : { customer: { email: command.customerEmail } }),
  });
  const root = object(response.json(), "dodo", "dodo.checkout.decode");
  const url = optionalString(root, "checkout_url");
  const value: ProviderCheckoutSnapshot = {
    externalId: stringField(root, "session_id", "dodo", "dodo.checkout.decode"),
    status: "open",
    ...(url === undefined ? {} : { url }),
    rawStatus: "created",
  };
  return result(context, value);
}

function decodeStatus(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "dodo", "dodo.checkout.decode");
  const rawStatus = optionalString(root, "payment_status") ?? "collecting_details";
  const status =
    rawStatus === "succeeded"
      ? "complete"
      : rawStatus === "failed" || rawStatus === "cancelled"
        ? "canceled"
        : "open";
  return { externalId: stringField(root, "id", "dodo", "dodo.checkout.decode"), status, rawStatus };
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
    idempotency: "both",
    warnings: [],
  };
}
