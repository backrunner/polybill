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
import { parseIsoDateTime } from "@polybill/core";
import { stripeRequest } from "./client.js";

export const stripeCheckout: CheckoutProvider = {
  async create(context, command) {
    return create(context, command);
  },
  async get(context, externalId) {
    return result(
      context,
      decode(
        (
          await stripeRequest(
            context,
            "GET",
            `/v1/checkout/sessions/${encodeURIComponent(externalId)}`,
          )
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
  const body = encode(command);
  return result(
    context,
    decode((await stripeRequest(context, "POST", "/v1/checkout/sessions", body)).json()),
  );
}

function encode(command: ProviderCheckoutCommand): URLSearchParams {
  const body = new URLSearchParams({
    mode: command.lines.some(
      (line) =>
        line.price.kind === "recurring" ||
        line.price.kind === "seat" ||
        line.price.kind === "metered",
    )
      ? "subscription"
      : "payment",
    success_url: command.successUrl,
    cancel_url: command.cancelUrl,
    client_reference_id: command.orderId,
  });
  if (command.customerEmail !== undefined) body.set("customer_email", command.customerEmail);
  for (const [key, value] of Object.entries(command.metadata)) body.set(`metadata[${key}]`, value);
  command.lines.forEach((line, index) => {
    const prefix = `line_items[${index}]`;
    body.set(`${prefix}[quantity]`, String(line.quantity));
    if (line.externalPriceId !== undefined) {
      body.set(`${prefix}[price]`, line.externalPriceId);
      return;
    }
    body.set(`${prefix}[price_data][currency]`, line.unitAmount.currency.toLowerCase());
    body.set(`${prefix}[price_data][unit_amount]`, line.unitAmount.amount);
    body.set(`${prefix}[price_data][product_data][name]`, line.skuId);
    if (line.price.kind === "recurring" || line.price.kind === "seat") {
      body.set(`${prefix}[price_data][recurring][interval]`, line.price.interval.unit);
      body.set(
        `${prefix}[price_data][recurring][interval_count]`,
        String(line.price.interval.count),
      );
    }
  });
  return body;
}

function decode(value: unknown): ProviderCheckoutSnapshot {
  const root = object(value, "stripe", "stripe.checkout.decode");
  const status = statusOf(optionalString(root, "status"));
  const expires = root.expires_at;
  const url = optionalString(root, "url");
  return {
    externalId: stringField(root, "id", "stripe", "stripe.checkout.decode"),
    status,
    ...(url === undefined ? {} : { url }),
    ...(typeof expires === "number"
      ? { expiresAt: parseIsoDateTime(new Date(expires * 1000).toISOString()) }
      : {}),
    rawStatus: optionalString(root, "status") ?? "unknown",
  };
}

function statusOf(value: string | undefined): ProviderCheckoutSnapshot["status"] {
  return value === "open" || value === "complete" || value === "expired" ? value : "unknown";
}

function result(
  context: ProviderContext,
  value: ProviderCheckoutSnapshot,
): ProviderOperationResult<ProviderCheckoutSnapshot> {
  return {
    value,
    evidence: {
      provider: "stripe",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      rawStatus: value.rawStatus,
    },
    idempotency: "both",
    warnings: [],
  };
}
