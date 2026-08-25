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
import { waffoRequest } from "./client.js";

export const waffoCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    throw new PolybillError(`Waffo does not expose checkout-session read-back for ${externalId}`, {
      code: "unsupported_capability",
      operation: "waffo.checkout.get",
      provider: "waffo",
      connectionId: context.connection.id,
      retryable: false,
    });
  },
};

async function create(
  context: ProviderContext,
  command: ProviderCheckoutCommand,
): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>> {
  const line = command.lines[0];
  if (
    command.lines.length !== 1 ||
    line === undefined ||
    line.externalPriceId === undefined ||
    line.quantity !== 1
  )
    throw new PolybillError("Waffo checkout requires one mapped product with quantity one", {
      code: "unsupported_capability",
      operation: "waffo.checkout.create",
      provider: "waffo",
      connectionId: context.connection.id,
      retryable: false,
    });
  const response = await waffoRequest(context, "/v1/actions/checkout/create-session", {
    productId: line.externalPriceId,
    currency: line.unitAmount.currency,
    ...(command.customerEmail === undefined ? {} : { buyerEmail: command.customerEmail }),
    successUrl: command.successUrl,
    metadata: command.metadata,
    orderMerchantExternalId: command.orderId,
  });
  const root = object(response.json(), "waffo", "waffo.checkout.decode");
  const data = object(root.data, "waffo", "waffo.checkout.decode");
  const expiresAt = optionalString(data, "expiresAt");
  const value: ProviderCheckoutSnapshot = {
    externalId: stringField(data, "sessionId", "waffo", "waffo.checkout.decode"),
    status: "open",
    url: stringField(data, "checkoutUrl", "waffo", "waffo.checkout.decode"),
    ...(expiresAt === undefined ? {} : { expiresAt: parseIsoDateTime(expiresAt) }),
    rawStatus: "created",
  };
  return {
    ...result(context, value),
    warnings: [
      {
        code: "cancel_url_not_supported",
        message: "Waffo checkout accepts a success URL but no per-session cancel URL",
      },
    ],
  };
}

function result(
  context: ProviderContext,
  value: ProviderCheckoutSnapshot,
): ProviderOperationResult<ProviderCheckoutSnapshot> {
  return {
    value,
    evidence: {
      provider: "waffo",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "both",
    warnings: [],
  };
}
