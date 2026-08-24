import type { DiscountId, SkuId } from "./ids.js";
import { addMoney, compareMoney, money, percentageOf, subtractMoney, type Money } from "./money.js";
import type { IsoDateTime } from "./time.js";

export type DiscountValue =
  | { readonly kind: "fixed"; readonly amount: Money }
  | { readonly kind: "percentage"; readonly basisPoints: number };

export interface Discount {
  readonly id: DiscountId;
  readonly code: string;
  readonly name: string;
  readonly value: DiscountValue;
  readonly eligibleSkuIds: readonly SkuId[];
  readonly eligibleCustomerRefs: readonly string[];
  readonly startsAt?: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
  readonly maxRedemptions?: number;
  readonly maxRedemptionsPerCustomer?: number;
  readonly status: "active" | "archived";
  readonly createdAt: IsoDateTime;
}

export interface DiscountQuoteInput {
  readonly lines: readonly { readonly skuId: SkuId; readonly subtotal: Money }[];
  readonly customerRef?: string;
  readonly now: IsoDateTime;
  readonly redemptionCount: number;
  readonly customerRedemptionCount: number;
}

export type DiscountQuote =
  | {
      readonly kind: "applied";
      readonly gross: Money;
      readonly eligibleSubtotal: Money;
      readonly discountAmount: Money;
      readonly net: Money;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "inactive"
        | "not_started"
        | "expired"
        | "global_limit_reached"
        | "customer_required"
        | "customer_ineligible"
        | "customer_limit_reached"
        | "sku_ineligible"
        | "currency_mismatch";
    };

export function quoteDiscount(discount: Discount, input: DiscountQuoteInput): DiscountQuote {
  validateDiscount(discount);
  count(input.redemptionCount, "redemption count");
  count(input.customerRedemptionCount, "customer redemption count");
  if (input.lines.length === 0) throw new RangeError("Discount quote requires at least one line");
  const gross = sum(input.lines.map((line) => line.subtotal));
  if (discount.status !== "active") return rejected("inactive");
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError("Discount quote time is invalid");
  if (discount.startsAt !== undefined && now < Date.parse(discount.startsAt))
    return rejected("not_started");
  if (discount.expiresAt !== undefined && now >= Date.parse(discount.expiresAt))
    return rejected("expired");
  if (discount.maxRedemptions !== undefined && input.redemptionCount >= discount.maxRedemptions)
    return rejected("global_limit_reached");
  if (input.customerRef === undefined && discount.maxRedemptionsPerCustomer !== undefined)
    return rejected("customer_required");
  if (discount.eligibleCustomerRefs.length > 0) {
    const customerRef = input.customerRef;
    if (customerRef === undefined) return rejected("customer_required");
    if (!discount.eligibleCustomerRefs.includes(customerRef))
      return rejected("customer_ineligible");
  }
  if (
    discount.maxRedemptionsPerCustomer !== undefined &&
    input.customerRedemptionCount >= discount.maxRedemptionsPerCustomer
  )
    return rejected("customer_limit_reached");
  const eligibleLines =
    discount.eligibleSkuIds.length === 0
      ? input.lines
      : input.lines.filter((line) => discount.eligibleSkuIds.includes(line.skuId));
  if (eligibleLines.length === 0) return rejected("sku_ineligible");
  const eligibleSubtotal = sum(eligibleLines.map((line) => line.subtotal));
  let discountAmount: Money;
  if (discount.value.kind === "percentage") {
    discountAmount = percentageOf(eligibleSubtotal, discount.value.basisPoints, "down");
  } else {
    if (discount.value.amount.currency !== eligibleSubtotal.currency)
      return rejected("currency_mismatch");
    discountAmount =
      compareMoney(discount.value.amount, eligibleSubtotal) > 0
        ? eligibleSubtotal
        : discount.value.amount;
  }
  return {
    kind: "applied",
    gross,
    eligibleSubtotal,
    discountAmount,
    net: subtractMoney(gross, discountAmount),
  };
}

export function validateDiscount(discount: Discount): void {
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(discount.code))
    throw new TypeError("Discount code must be 2-64 uppercase characters");
  if (discount.name.length < 1 || discount.name.length > 200)
    throw new TypeError("Discount name must be 1-200 characters");
  if (discount.status !== "active" && discount.status !== "archived")
    throw new TypeError("Discount status is invalid");
  if (
    discount.eligibleCustomerRefs.some((value) => value.length < 1 || value.length > 255) ||
    discount.eligibleCustomerRefs.length > 10_000 ||
    discount.eligibleSkuIds.length > 10_000
  )
    throw new RangeError("Discount eligibility constraints are invalid");
  if (discount.value.kind === "percentage") {
    if (
      !Number.isSafeInteger(discount.value.basisPoints) ||
      discount.value.basisPoints < 1 ||
      discount.value.basisPoints > 10_000
    )
      throw new RangeError("Discount basis points must be an integer between 1 and 10000");
  } else if (discount.value.amount.amount === "0") {
    throw new RangeError("Fixed discount amount must be positive");
  }
  optionalCount(discount.maxRedemptions, "maximum redemptions");
  optionalCount(discount.maxRedemptionsPerCustomer, "customer maximum redemptions");
  const created = instant(discount.createdAt, "created time");
  const starts = optionalInstant(discount.startsAt, "start time");
  const expires = optionalInstant(discount.expiresAt, "expiry time");
  if (starts !== undefined && expires !== undefined && starts >= expires)
    throw new RangeError("Discount start must precede expiry");
  if (expires !== undefined && created >= expires)
    throw new RangeError("Discount expiry must follow creation");
}

function sum(values: readonly Money[]): Money {
  const first = values[0];
  if (first === undefined) throw new RangeError("Money sum requires at least one value");
  return values.slice(1).reduce(addMoney, money(first.amount, first.currency));
}

function rejected(reason: Extract<DiscountQuote, { kind: "rejected" }>["reason"]): DiscountQuote {
  return { kind: "rejected", reason };
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`Discount ${name} must be a non-negative safe integer`);
}

function optionalCount(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new RangeError(`Discount ${name} must be a positive safe integer`);
}

function instant(value: IsoDateTime, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Discount ${name} is invalid`);
  return parsed;
}

function optionalInstant(value: IsoDateTime | undefined, name: string): number | undefined {
  return value === undefined ? undefined : instant(value, name);
}
