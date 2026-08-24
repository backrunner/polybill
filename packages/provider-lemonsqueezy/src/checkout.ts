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
import { lemonRequest } from "./client.js";

export const lemonCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    return result(
      context,
      decode(
        (await lemonRequest(context, "GET", `/checkouts/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
};

async function create(
  context: ProviderContext,
  command: ProviderCheckoutCommand,
): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>> {
  const line = command.lines[0];
  const storeId = context.credentials.storeId;
  if (storeId === undefined)
    throw new PolybillError("Lemon Squeezy store ID is missing", {
      code: "authentication_failed",
      operation: "lemonSqueezy.checkout.create",
      provider: "lemonSqueezy",
      connectionId: context.connection.id,
      retryable: false,
    });
  if (
    command.lines.length !== 1 ||
    line === undefined ||
    line.externalPriceId === undefined ||
    line.quantity !== 1
  )
    throw new PolybillError(
      "Lemon Squeezy checkout requires one mapped variant with quantity one",
      {
        code: "unsupported_capability",
        operation: "lemonSqueezy.checkout.create",
        provider: "lemonSqueezy",
        connectionId: context.connection.id,
        retryable: false,
      },
    );
  const body = {
    data: {
      type: "checkouts",
      attributes: {
        product_options: { redirect_url: command.successUrl },
        checkout_data: {
          ...(command.customerEmail === undefined ? {} : { email: command.customerEmail }),
          custom: { ...command.metadata, polybill_order_id: command.orderId },
        },
        ...(line.price.kind === "custom" ? { custom_price: line.unitAmount.amount } : {}),
      },
      relationships: {
        store: { data: { type: "stores", id: storeId } },
        variant: { data: { type: "variants", id: line.externalPriceId } },
      },
    },
  };
  const value = decode((await lemonRequest(context, "POST", "/checkouts", body)).json());
  return {
    ...result(context, value),
    warnings: [
      {
        code: "cancel_url_not_supported",
        message: "Lemon Squeezy checkout does not accept a distinct cancel URL",
      },
    ],
  };
}

function decode(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "lemonSqueezy", "lemonSqueezy.checkout.decode");
  const data = object(root.data, "lemonSqueezy", "lemonSqueezy.checkout.decode");
  const attributes = object(data.attributes, "lemonSqueezy", "lemonSqueezy.checkout.decode");
  const url = optionalString(attributes, "url");
  const expiresAt = optionalString(attributes, "expires_at");
  return {
    externalId: stringField(data, "id", "lemonSqueezy", "lemonSqueezy.checkout.decode"),
    status: "open",
    ...(url === undefined ? {} : { url }),
    ...(expiresAt === undefined ? {} : { expiresAt: parseIsoDateTime(expiresAt) }),
    rawStatus: "created",
  };
}

function result(
  context: ProviderContext,
  value: ProviderCheckoutSnapshot,
): ProviderOperationResult<ProviderCheckoutSnapshot> {
  return {
    value,
    evidence: {
      provider: "lemonSqueezy",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "polybill",
    warnings: [],
  };
}
