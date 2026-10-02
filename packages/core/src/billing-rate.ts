import { money, parseCurrency, type Currency, type Money } from "./money.js";

/** Decimal minor units per integer usage unit. This is deliberately not Money. */
export interface BillingRate {
  readonly amount: string;
  readonly currency: Currency;
}
export type BillingRounding = "down" | "up" | "half_up" | "half_even";
export interface BillingRateTier {
  readonly upTo?: string;
  readonly unit: BillingRate;
  readonly flat?: BillingRate;
}

export function billingRate(amount: string, currency: string): BillingRate {
  decimal(amount);
  return { amount, currency: parseCurrency(currency) };
}

export function usageQuantity(value: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw new TypeError("Usage quantity must be a nonnegative integer string of at most 78 digits");
  return value;
}

export function priceUsage(
  quantity: string,
  tiers: readonly BillingRateTier[],
  mode: "graduated" | "volume",
  rounding: BillingRounding,
): Money {
  const units = BigInt(usageQuantity(quantity));
  if (mode !== "graduated" && mode !== "volume") throw new TypeError("Invalid tier mode");
  if (!["down", "up", "half_up", "half_even"].includes(rounding))
    throw new TypeError("Invalid billing rounding");
  const first = tiers[0];
  if (first === undefined || tiers.length > 1000) throw new TypeError("Invalid billing tiers");
  const currency = parseCurrency(first.unit.currency);
  let previous = 0n;
  let scale = 0;
  const parsed = tiers.map((tier, index) => {
    if (tier.unit.currency !== currency || (tier.flat && tier.flat.currency !== currency))
      throw new TypeError("Billing tier currencies must agree");
    const upper = tier.upTo === undefined ? undefined : BigInt(usageQuantity(tier.upTo));
    if (upper === undefined ? index !== tiers.length - 1 : upper <= previous)
      throw new TypeError("Billing tiers must increase and end with an unlimited tier");
    if (index === tiers.length - 1 && upper !== undefined)
      throw new TypeError("The final billing tier must be unlimited");
    const unit = decimal(tier.unit.amount);
    const flat = decimal(tier.flat?.amount ?? "0");
    scale = Math.max(scale, unit.scale, flat.scale);
    const lower = previous;
    previous = upper ?? previous;
    return { upper, lower, unit, flat };
  });
  const expand = (value: { coefficient: bigint; scale: number }) =>
    value.coefficient * 10n ** BigInt(scale - value.scale);
  let total = 0n;
  // Zero consumption has no tier entry fee; a recurring base charge is a separate price.
  if (units > 0n) {
    for (const tier of parsed) {
      if (mode === "volume") {
        if (tier.upper === undefined || units <= tier.upper) {
          total = units * expand(tier.unit) + expand(tier.flat);
          break;
        }
      } else if (units > tier.lower) {
        const upper = tier.upper === undefined || units < tier.upper ? units : tier.upper;
        total += (upper - tier.lower) * expand(tier.unit) + expand(tier.flat);
      }
    }
  }
  const divisor = 10n ** BigInt(scale);
  const quotient = total / divisor;
  const remainder = total % divisor;
  const increment =
    (rounding === "up" && remainder > 0n) ||
    (rounding === "half_up" && remainder * 2n >= divisor) ||
    (rounding === "half_even" &&
      (remainder * 2n > divisor || (remainder * 2n === divisor && quotient % 2n === 1n)));
  return money(String(quotient + (increment ? 1n : 0n)), currency);
}

function decimal(value: string): { coefficient: bigint; scale: number } {
  if (!/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,18})?$/.test(value))
    throw new TypeError(
      "Billing rate must be a nonnegative decimal string with at most 18 decimals",
    );
  const [whole = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
