import { unsafeBrand, type Brand } from "./brand.js";

export type MinorUnit = Brand<string, "MinorUnit">;
export type AtomicUnit = Brand<string, "AtomicUnit">;
export type Currency = Brand<string, "Currency">;

export interface Money {
  readonly amount: MinorUnit;
  readonly currency: Currency;
}

export interface DigitalAsset {
  readonly network: string;
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface AssetAmount {
  readonly amount: AtomicUnit;
  readonly asset: DigitalAsset;
}

export type RoundingMode = "down" | "half_up" | "up";

const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const CURRENCY = /^[A-Z]{3}$/;

export function parseMinorUnit(value: unknown): MinorUnit {
  if (typeof value !== "string" || !UNSIGNED_INTEGER.test(value)) {
    throw new TypeError("Money amount must be an unsigned decimal integer string");
  }
  return unsafeBrand<string, "MinorUnit">(value);
}

export function parseAtomicUnit(value: unknown): AtomicUnit {
  if (typeof value !== "string" || !UNSIGNED_INTEGER.test(value)) {
    throw new TypeError("Asset amount must be an unsigned decimal integer string");
  }
  return unsafeBrand<string, "AtomicUnit">(value);
}

export function parseCurrency(value: unknown): Currency {
  if (typeof value !== "string" || !CURRENCY.test(value)) {
    throw new TypeError("Currency must be a three-letter uppercase ISO-4217 code");
  }
  return unsafeBrand<string, "Currency">(value);
}

export function money(amount: string, currency: string): Money {
  return { amount: parseMinorUnit(amount), currency: parseCurrency(currency) };
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money((BigInt(left.amount) + BigInt(right.amount)).toString(), left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  const result = BigInt(left.amount) - BigInt(right.amount);
  if (result < 0n) throw new RangeError("Money subtraction cannot produce a negative amount");
  return money(result.toString(), left.currency);
}

export function multiplyMoney(value: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError("Quantity must be a non-negative safe integer");
  }
  return money((BigInt(value.amount) * BigInt(quantity)).toString(), value.currency);
}

export function percentageOf(value: Money, basisPoints: number, mode: RoundingMode): Money {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError("Basis points must be an integer between 0 and 10000");
  }
  const numerator = BigInt(value.amount) * BigInt(basisPoints);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const increment =
    remainder === 0n
      ? 0n
      : mode === "up" || (mode === "half_up" && remainder * 2n >= denominator)
        ? 1n
        : 0n;
  return money((quotient + increment).toString(), value.currency);
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  const a = BigInt(left.amount);
  const b = BigInt(right.amount);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) throw new TypeError("Money currencies must match");
}
