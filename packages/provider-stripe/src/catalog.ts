import {
  object,
  optionalString,
  stringField,
  type CatalogProvider,
  type ProviderPriceSnapshot,
  type ProviderProductSnapshot,
} from "@polybill/adapter-kit";
import { money, parseCurrency, type PriceModel } from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeCatalog: CatalogProvider = {
  async createProduct(context, input) {
    const body = metadata(
      new URLSearchParams({
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
      input.metadata,
    );
    return stripeResult(
      context,
      decodeProduct((await stripeRequest(context, "POST", "/v1/products", body)).json()),
    );
  },
  async getProduct(context, externalId) {
    return stripeResult(
      context,
      decodeProduct(
        (
          await stripeRequest(context, "GET", `/v1/products/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async archiveProduct(context, externalId) {
    return stripeResult(
      context,
      decodeProduct(
        (
          await stripeRequest(
            context,
            "POST",
            `/v1/products/${encodeURIComponent(externalId)}`,
            new URLSearchParams({ active: "false" }),
          )
        ).json(),
      ),
    );
  },
  async createPrice(context, input) {
    const body = encodePrice(input.externalProductId, input.model, input.taxBehavior);
    for (const [key, value] of Object.entries(input.metadata)) body.set(`metadata[${key}]`, value);
    return stripeResult(
      context,
      decodePrice((await stripeRequest(context, "POST", "/v1/prices", body)).json()),
    );
  },
  async getPrice(context, externalId) {
    return stripeResult(
      context,
      decodePrice(
        (
          await stripeRequest(context, "GET", `/v1/prices/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async retirePrice(context, externalId) {
    return stripeResult(
      context,
      decodePrice(
        (
          await stripeRequest(
            context,
            "POST",
            `/v1/prices/${encodeURIComponent(externalId)}`,
            new URLSearchParams({ active: "false" }),
          )
        ).json(),
      ),
    );
  },
};

function encodePrice(product: string, model: PriceModel, taxBehavior: string): URLSearchParams {
  const body = new URLSearchParams({ product, tax_behavior: taxBehavior });
  if (model.kind === "free") {
    body.set("currency", model.currency.toLowerCase());
    body.set("unit_amount", "0");
    return body;
  }
  if (model.kind === "custom" || model.kind === "metered")
    throw new TypeError(
      "Stripe reusable price mapper does not support custom or metered models yet",
    );
  body.set("currency", model.unit.currency.toLowerCase());
  body.set("unit_amount", model.unit.amount);
  if (model.kind === "recurring" || model.kind === "seat") {
    body.set("recurring[interval]", model.interval.unit);
    body.set("recurring[interval_count]", String(model.interval.count));
  }
  return body;
}

function decodeProduct(value: unknown): ProviderProductSnapshot {
  const root = object(value, "stripe", "stripe.product.decode");
  const active = root.active;
  const description = optionalString(root, "description");
  return {
    externalId: stringField(root, "id", "stripe", "stripe.product.decode"),
    name: stringField(root, "name", "stripe", "stripe.product.decode"),
    ...(description === undefined ? {} : { description }),
    status: active === true ? "active" : active === false ? "archived" : "unknown",
    rawStatus: String(active),
  };
}

function decodePrice(value: unknown): ProviderPriceSnapshot {
  const root = object(value, "stripe", "stripe.price.decode");
  const currency = parseCurrency(
    stringField(root, "currency", "stripe", "stripe.price.decode").toUpperCase(),
  );
  const amount = root.unit_amount;
  if (!Number.isSafeInteger(amount) || Number(amount) < 0)
    throw new TypeError("Stripe price unit amount is invalid");
  const recurring = root.recurring;
  const model: PriceModel =
    recurring === null || recurring === undefined
      ? { kind: "one_time", unit: money(String(amount), currency) }
      : recurringModel(recurring, String(amount), currency);
  const active = root.active;
  return {
    externalId: stringField(root, "id", "stripe", "stripe.price.decode"),
    externalProductId: stringField(root, "product", "stripe", "stripe.price.decode"),
    model,
    status: active === true ? "active" : active === false ? "retired" : "unknown",
    rawStatus: String(active),
  };
}

function recurringModel(
  value: unknown,
  amount: string,
  currency: ReturnType<typeof parseCurrency>,
): PriceModel {
  const root = object(value, "stripe", "stripe.price.decode");
  const interval = stringField(root, "interval", "stripe", "stripe.price.decode");
  const count = root.interval_count;
  if (
    !["day", "week", "month", "year"].includes(interval) ||
    !Number.isSafeInteger(count) ||
    Number(count) < 1
  )
    throw new TypeError("Stripe recurring interval is invalid");
  return {
    kind: "recurring",
    unit: money(amount, currency),
    interval: { unit: interval as "day" | "week" | "month" | "year", count: Number(count) },
  };
}

function metadata(
  body: URLSearchParams,
  values: Readonly<Record<string, string>>,
): URLSearchParams {
  for (const [key, value] of Object.entries(values)) body.set(`metadata[${key}]`, value);
  return body;
}
