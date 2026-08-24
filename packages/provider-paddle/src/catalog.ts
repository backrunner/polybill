import {
  object,
  optionalString,
  stringField,
  type CatalogProvider,
  type ProviderPriceSnapshot,
  type ProviderProductSnapshot,
} from "@polybill/adapter-kit";
import { money, parseCurrency, type PriceModel } from "@polybill/core";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleCatalog: CatalogProvider = {
  async createProduct(context, input) {
    return paddleResult(
      context,
      decodeProduct(
        (
          await paddleRequest(context, "POST", "/products", {
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            tax_category: "standard",
            custom_data: input.metadata,
          })
        ).json(),
      ),
    );
  },
  async getProduct(context, externalId) {
    return paddleResult(
      context,
      decodeProduct(
        (await paddleRequest(context, "GET", `/products/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
  async updateProduct(context, externalId, input) {
    return paddleResult(
      context,
      decodeProduct(
        (
          await paddleRequest(context, "PATCH", `/products/${encodeURIComponent(externalId)}`, {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.metadata === undefined ? {} : { custom_data: input.metadata }),
          })
        ).json(),
      ),
    );
  },
  async archiveProduct(context, externalId) {
    return paddleResult(
      context,
      decodeProduct(
        (
          await paddleRequest(context, "PATCH", `/products/${encodeURIComponent(externalId)}`, {
            status: "archived",
          })
        ).json(),
      ),
    );
  },
  async createPrice(context, input) {
    return paddleResult(
      context,
      decodePrice(
        (
          await paddleRequest(context, "POST", "/prices", {
            product_id: input.externalProductId,
            description: input.metadata.description ?? `Polybill ${input.externalProductId}`,
            tax_mode: taxMode(input.taxBehavior),
            unit_price: unitPrice(input.model),
            billing_cycle: billingCycle(input.model),
            custom_data: input.metadata,
          })
        ).json(),
      ),
    );
  },
  async getPrice(context, externalId) {
    return paddleResult(
      context,
      decodePrice(
        (await paddleRequest(context, "GET", `/prices/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
  async retirePrice(context, externalId) {
    return paddleResult(
      context,
      decodePrice(
        (
          await paddleRequest(context, "PATCH", `/prices/${encodeURIComponent(externalId)}`, {
            status: "archived",
          })
        ).json(),
      ),
    );
  },
};

function data(value: unknown, operation: string) {
  return object(object(value, "paddle", operation).data, "paddle", operation);
}

function decodeProduct(value: unknown): ProviderProductSnapshot {
  const root = data(value, "paddle.product.decode");
  const rawStatus = optionalString(root, "status") ?? "unknown";
  const description = optionalString(root, "description");
  return {
    externalId: stringField(root, "id", "paddle", "paddle.product.decode"),
    name: stringField(root, "name", "paddle", "paddle.product.decode"),
    ...(description === undefined ? {} : { description }),
    status: rawStatus === "active" ? "active" : rawStatus === "archived" ? "archived" : "unknown",
    rawStatus,
  };
}

function decodePrice(value: unknown): ProviderPriceSnapshot {
  const root = data(value, "paddle.price.decode");
  const unit = object(root.unit_price, "paddle", "paddle.price.decode");
  const currency = parseCurrency(
    stringField(unit, "currency_code", "paddle", "paddle.price.decode"),
  );
  const amount = stringField(unit, "amount", "paddle", "paddle.price.decode");
  const cycle = root.billing_cycle;
  const model: PriceModel =
    cycle === null || cycle === undefined
      ? { kind: "one_time", unit: money(amount, currency) }
      : recurring(cycle, amount, currency);
  const rawStatus = optionalString(root, "status") ?? "unknown";
  return {
    externalId: stringField(root, "id", "paddle", "paddle.price.decode"),
    externalProductId: stringField(root, "product_id", "paddle", "paddle.price.decode"),
    model,
    status: rawStatus === "active" ? "active" : rawStatus === "archived" ? "retired" : "unknown",
    rawStatus,
  };
}

function recurring(
  value: unknown,
  amount: string,
  currency: ReturnType<typeof parseCurrency>,
): PriceModel {
  const root = object(value, "paddle", "paddle.price.decode");
  const interval = stringField(root, "interval", "paddle", "paddle.price.decode");
  const frequency = root.frequency;
  if (
    !(["day", "week", "month", "year"] as const).includes(interval as never) ||
    !Number.isSafeInteger(frequency) ||
    Number(frequency) < 1
  )
    throw new TypeError("Paddle billing cycle is invalid");
  return {
    kind: "recurring",
    unit: money(amount, currency),
    interval: { unit: interval as "day" | "week" | "month" | "year", count: Number(frequency) },
  };
}

function unitPrice(model: PriceModel) {
  if (model.kind === "free") return { amount: "0", currency_code: model.currency };
  if (model.kind === "one_time" || model.kind === "recurring" || model.kind === "seat")
    return { amount: model.unit.amount, currency_code: model.unit.currency };
  throw new TypeError("Paddle reusable catalog price cannot represent this price model exactly");
}

function billingCycle(model: PriceModel) {
  return model.kind === "recurring" || model.kind === "seat"
    ? { interval: model.interval.unit, frequency: model.interval.count }
    : null;
}

function taxMode(value: "inclusive" | "exclusive" | "unspecified") {
  return value === "inclusive"
    ? "internal"
    : value === "exclusive"
      ? "external"
      : "account_setting";
}
