import {
  object,
  optionalString,
  providerIntegerAmount,
  providerIdempotencyKey,
  stringField,
  type CheckoutProvider,
  type ProviderCheckoutCommand,
  type ProviderCheckoutSnapshot,
  type ProviderContext,
  type ProviderOperationResult,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { creemRequest } from "./client.js";

export const creemCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    const query = new URLSearchParams({ checkout_id: externalId });
    return result(
      context,
      decode((await creemRequest(context, "GET", `/v1/checkouts?${query.toString()}`)).json()),
    );
  },
};

async function create(
  context: ProviderContext,
  command: ProviderCheckoutCommand,
): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>> {
  if (command.customerId !== undefined && command.externalCustomerId === undefined)
    throw new PolybillError(
      "Creem checkout requires a connection mapping for the supplied customer",
      {
        code: "not_found",
        operation: "creem.checkout.create",
        provider: "creem",
        connectionId: context.connection.id,
        retryable: false,
      },
    );
  const line = command.lines[0];
  if (command.lines.length !== 1 || line === undefined || line.externalPriceId === undefined)
    throw new PolybillError("Creem checkout requires exactly one mapped product", {
      code: "unsupported_capability",
      operation: "creem.checkout.create",
      provider: "creem",
      connectionId: context.connection.id,
      retryable: false,
    });
  const body = {
    request_id: await providerIdempotencyKey(context, "POST", "/v1/checkouts"),
    product_id: line.externalPriceId,
    units: line.quantity,
    success_url: command.successUrl,
    metadata: { ...command.metadata, polybill_order_id: command.orderId },
    ...(line.price.kind === "custom"
      ? { custom_price: providerIntegerAmount(line.unitAmount.amount, "creem", 99_999_999, 100) }
      : {}),
    ...(command.externalCustomerId !== undefined
      ? { customer: { id: command.externalCustomerId } }
      : command.customerEmail === undefined
        ? {}
        : { customer: { email: command.customerEmail } }),
  };
  const value = decode((await creemRequest(context, "POST", "/v1/checkouts", body)).json());
  return {
    ...result(context, value),
    warnings: [
      {
        code: "cancel_url_not_supported",
        message: "Creem checkout does not accept a per-session cancel URL",
      },
    ],
  };
}

function decode(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "creem", "creem.checkout.decode");
  const rawStatus = optionalString(root, "status") ?? "unknown";
  const status =
    rawStatus === "completed"
      ? "complete"
      : rawStatus === "expired"
        ? "expired"
        : rawStatus === "pending" || rawStatus === "processing"
          ? "open"
          : "unknown";
  const url = optionalString(root, "checkout_url");
  const subscription = root.subscription;
  const subscriptionId =
    subscription === undefined || subscription === null
      ? undefined
      : typeof subscription === "string"
        ? subscription
        : stringField(
            object(subscription, "creem", "creem.checkout.decode"),
            "id",
            "creem",
            "creem.checkout.decode",
          );
  return {
    externalId: stringField(root, "id", "creem", "creem.checkout.decode"),
    externalSubscriptionIds: subscriptionId === undefined ? [] : [subscriptionId],
    status,
    ...(url === undefined ? {} : { url }),
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
      provider: "creem",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "polybill",
    warnings: [],
  };
}
