import {
  arrayField,
  object,
  stringField,
  type DiscountProvider,
  type ProviderDiscountSnapshot,
} from "@polybill/adapter-kit";
import { money, parseIsoDateTime } from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeDiscounts: DiscountProvider = {
  async create(context, input) {
    assertSupported(input.discount);
    return stripeResult(
      context,
      decode((await stripeRequest(context, "POST", "/v1/coupons", encode(input))).json()),
    );
  },
  async get(context, externalId) {
    return stripeResult(
      context,
      decode(
        (
          await stripeRequest(context, "GET", `/v1/coupons/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
};

function encode(input: Parameters<NonNullable<DiscountProvider["create"]>>[1]): URLSearchParams {
  const discount = input.discount;
  const body = new URLSearchParams({
    duration: "once",
    name: discount.name.slice(0, 40),
    "metadata[polybill_discount_id]": discount.id,
    ...(discount.expiresAt === undefined
      ? {}
      : { redeem_by: String(Math.floor(Date.parse(discount.expiresAt) / 1000)) }),
    ...(discount.maxRedemptions === undefined
      ? {}
      : { max_redemptions: String(discount.maxRedemptions) }),
  });
  if (discount.value.kind === "fixed") {
    body.set("amount_off", discount.value.amount.amount);
    body.set("currency", discount.value.amount.currency.toLowerCase());
  } else {
    body.set("percent_off", percentage(discount.value.basisPoints));
  }
  input.externalProductIds.forEach((id, index) => body.set(`applies_to[products][${index}]`, id));
  return body;
}

function assertSupported(
  discount: Parameters<NonNullable<DiscountProvider["create"]>>[1]["discount"],
): void {
  if (
    discount.startsAt !== undefined ||
    discount.maxRedemptionsPerCustomer !== undefined ||
    discount.eligibleCustomerRefs.length > 0
  )
    throw new TypeError(
      "Stripe coupons cannot represent discount start time, customer allowlists, or per-customer limits",
    );
}

function decode(value: unknown): ProviderDiscountSnapshot {
  const root = object(value, "stripe", "stripe.discount.decode");
  const redeemBy = root.redeem_by;
  const appliesToValue = root.applies_to;
  const externalProductIds =
    appliesToValue === undefined || appliesToValue === null
      ? []
      : arrayField(
          object(appliesToValue, "stripe", "stripe.discount.decode"),
          "products",
          "stripe",
          "stripe.discount.decode",
        ).map((item) => {
          if (typeof item !== "string") throw invalidDiscount();
          return item;
        });
  const maxRedemptions = optionalPositiveInteger(root.max_redemptions);
  return {
    externalId: stringField(root, "id", "stripe", "stripe.discount.decode"),
    value: decodeValue(root),
    status: root.valid === true ? "active" : root.valid === false ? "unavailable" : "unknown",
    externalProductIds,
    ...(maxRedemptions === undefined ? {} : { maxRedemptions }),
    ...(typeof redeemBy === "number" && Number.isSafeInteger(redeemBy) && redeemBy > 0
      ? { expiresAt: parseIsoDateTime(new Date(redeemBy * 1000).toISOString()) }
      : {}),
    rawStatus: String(root.valid),
  };
}

function decodeValue(root: Readonly<Record<string, unknown>>): ProviderDiscountSnapshot["value"] {
  if (root.amount_off !== null && root.amount_off !== undefined) {
    if (!Number.isSafeInteger(root.amount_off) || Number(root.amount_off) <= 0)
      throw invalidDiscount();
    return {
      kind: "fixed",
      amount: money(
        String(root.amount_off),
        stringField(root, "currency", "stripe", "stripe.discount.decode").toUpperCase(),
      ),
    };
  }
  if (typeof root.percent_off !== "number") throw invalidDiscount();
  return { kind: "percentage", basisPoints: basisPoints(String(root.percent_off)) };
}

function percentage(value: number): string {
  const whole = Math.floor(value / 100);
  const fraction = String(value % 100).padStart(2, "0");
  return fraction === "00" ? String(whole) : `${whole}.${fraction.replace(/0$/, "")}`;
}

function basisPoints(value: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) throw invalidDiscount();
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const result = whole * 100 + fraction;
  if (result < 1 || result > 10_000) throw invalidDiscount();
  return result;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalidDiscount();
  return Number(value);
}

function invalidDiscount(): TypeError {
  return new TypeError("Stripe discount response is invalid");
}
