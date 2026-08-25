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
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import { polarRequest } from "./client.js";

export const polarCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    return result(
      context,
      decode(
        (
          await polarRequest(context, "GET", `/v1/checkouts/${encodeURIComponent(externalId)}`)
        ).json(),
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
  const products = command.lines.map((line) => {
    if (line.externalPriceId === undefined)
      throw new PolybillError("Polar checkout requires a mapped product", {
        code: "unsupported_capability",
        operation: "polar.checkout.create",
        provider: "polar",
        connectionId: context.connection.id,
        retryable: false,
      });
    if (line.quantity !== 1 && (command.lines.length !== 1 || line.price.kind !== "seat"))
      throw new PolybillError("Polar checkout cannot represent this line quantity", {
        code: "unsupported_capability",
        operation: "polar.checkout.create",
        provider: "polar",
        connectionId: context.connection.id,
        retryable: false,
      });
    return line.externalPriceId;
  });
  const seatLine =
    command.lines.length === 1 && command.lines[0]?.price.kind === "seat"
      ? command.lines[0]
      : undefined;
  const response = await polarRequest(context, "POST", "/v1/checkouts/", {
    products,
    success_url: command.successUrl,
    return_url: command.cancelUrl,
    metadata: { ...command.metadata, polybill_order_id: command.orderId },
    ...(command.customerEmail === undefined ? {} : { customer_email: command.customerEmail }),
    ...(seatLine === undefined ? {} : { seats: seatLine.quantity }),
  });
  return result(context, decode(response.json()));
}

function decode(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "polar", "polar.checkout.decode");
  const externalPaymentId = optionalString(root, "payment_id");
  const rawStatus = optionalString(root, "status") ?? "unknown";
  const status =
    rawStatus === "succeeded"
      ? "complete"
      : rawStatus === "expired"
        ? "expired"
        : rawStatus === "failed"
          ? "canceled"
          : rawStatus === "open" || rawStatus === "confirmed"
            ? "open"
            : "unknown";
  const url = optionalString(root, "url");
  const expiresAt = optionalString(root, "expires_at");
  return {
    externalId: stringField(root, "id", "polar", "polar.checkout.decode"),
    ...(externalPaymentId === undefined ? {} : { externalPaymentId }),
    status,
    ...(url === undefined ? {} : { url }),
    ...(expiresAt === undefined ? {} : { expiresAt: parseIsoDateTime(expiresAt) }),
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
      provider: "polar",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "both",
    warnings: [],
  };
}
