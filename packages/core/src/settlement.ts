import type { SettlementQuoteId } from "./ids.js";
import type { AssetAmount, Money } from "./money.js";
import type { IsoDateTime } from "./time.js";

export interface SettlementQuote {
  readonly id: SettlementQuoteId;
  readonly pricingAmount: Money;
  readonly settlementAmount: AssetAmount;
  readonly source: "merchant_fixed" | "quote_provider";
  readonly quotedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

export function assertSettlementQuoteValid(
  quote: SettlementQuote,
  expected: Money,
  now: IsoDateTime,
): void {
  if (
    quote.pricingAmount.amount !== expected.amount ||
    quote.pricingAmount.currency !== expected.currency
  ) {
    throw new TypeError("Settlement quote pricing amount does not match the order");
  }
  if (Date.parse(quote.expiresAt) <= Date.parse(now)) {
    throw new RangeError("Settlement quote has expired");
  }
}
