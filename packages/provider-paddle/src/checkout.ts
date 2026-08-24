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
import { paddleRequest } from "./client.js";

export const paddleCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    return result(
      context,
      decode(
        (
          await paddleRequest(context, "GET", `/transactions/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
};

async function create(
  context: ProviderContext,
  command: ProviderCheckoutCommand,
): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>> {
  const items = command.lines.map((line) =>
    line.externalPriceId === undefined
      ? {
          quantity: line.quantity,
          price: {
            description: `Polybill ${line.skuId}`,
            name: line.skuId,
            billing_cycle:
              line.price.kind === "recurring" || line.price.kind === "seat"
                ? { interval: line.price.interval.unit, frequency: line.price.interval.count }
                : null,
            tax_mode: "account_setting",
            unit_price: { amount: line.unitAmount.amount, currency_code: line.unitAmount.currency },
            product: {
              name: line.skuId,
              tax_category: "standard",
              description: `Polybill SKU ${line.skuId}`,
            },
          },
        }
      : { quantity: line.quantity, price_id: line.externalPriceId },
  );
  const response = await paddleRequest(context, "POST", "/transactions", {
    items,
    collection_mode: "automatic",
    custom_data: { ...command.metadata, polybill_order_id: command.orderId },
  });
  return {
    ...result(context, decode(response.json())),
    warnings: [
      {
        code: "redirect_urls_application_owned",
        message:
          "Paddle transaction checkout redirect behavior is configured by Paddle.js or the application",
      },
    ],
  };
}

function decode(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "paddle", "paddle.transaction.decode");
  const data = object(root.data, "paddle", "paddle.transaction.decode");
  const rawStatus = optionalString(data, "status") ?? "unknown";
  const status =
    rawStatus === "completed" || rawStatus === "paid"
      ? "complete"
      : rawStatus === "canceled"
        ? "canceled"
        : ["draft", "ready", "billed", "past_due"].includes(rawStatus)
          ? "open"
          : "unknown";
  const checkout =
    data.checkout === null || data.checkout === undefined
      ? undefined
      : object(data.checkout, "paddle", "paddle.transaction.decode");
  const url = checkout === undefined ? undefined : optionalString(checkout, "url");
  return {
    externalId: stringField(data, "id", "paddle", "paddle.transaction.decode"),
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
      provider: "paddle",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "polybill",
    warnings: [],
  };
}
