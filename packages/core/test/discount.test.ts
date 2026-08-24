import { describe, expect, it } from "vitest";
import {
  money,
  parseId,
  parseIsoDateTime,
  quoteDiscount,
  type Discount,
  type SkuId,
} from "../src/index.js";

const pro = parseId<"SkuId">("sku_discountpro", "sku");
const addon = parseId<"SkuId">("sku_discountadd", "sku");
const now = parseIsoDateTime("2026-08-25T00:00:00.000Z");

describe("discount", () => {
  it("applies percentage discounts only to eligible SKU subtotals", () => {
    const quote = quoteDiscount(discount({ eligibleSkuIds: [pro] }), {
      lines: [line(pro, "1001"), line(addon, "500")],
      customerRef: "customer-1",
      now,
      redemptionCount: 0,
      customerRedemptionCount: 0,
    });
    expect(quote).toEqual({
      kind: "applied",
      gross: money("1501", "USD"),
      eligibleSubtotal: money("1001", "USD"),
      discountAmount: money("100", "USD"),
      net: money("1401", "USD"),
    });
  });

  it("caps fixed discounts at eligible subtotal without making the order negative", () => {
    const quote = quoteDiscount(
      discount({ value: { kind: "fixed", amount: money("5000", "USD") } }),
      {
        lines: [line(pro, "1200")],
        now,
        redemptionCount: 0,
        customerRedemptionCount: 0,
      },
    );
    expect(quote).toMatchObject({
      kind: "applied",
      discountAmount: money("1200", "USD"),
      net: money("0", "USD"),
    });
  });

  it("rejects time, customer, currency, and redemption constraint violations", () => {
    const base = {
      lines: [line(pro, "1200")],
      now,
      redemptionCount: 0,
      customerRedemptionCount: 0,
    };
    expect(
      quoteDiscount(discount({ startsAt: parseIsoDateTime("2026-08-26T00:00:00.000Z") }), base),
    ).toEqual({ kind: "rejected", reason: "not_started" });
    expect(
      quoteDiscount(discount({ eligibleCustomerRefs: ["customer-2"] }), {
        ...base,
        customerRef: "customer-1",
      }),
    ).toEqual({ kind: "rejected", reason: "customer_ineligible" });
    expect(quoteDiscount(discount({ maxRedemptions: 1 }), { ...base, redemptionCount: 1 })).toEqual(
      { kind: "rejected", reason: "global_limit_reached" },
    );
    expect(quoteDiscount(discount({ maxRedemptionsPerCustomer: 1 }), base)).toEqual({
      kind: "rejected",
      reason: "customer_required",
    });
    expect(
      quoteDiscount(discount({ value: { kind: "fixed", amount: money("100", "EUR") } }), base),
    ).toEqual({ kind: "rejected", reason: "currency_mismatch" });
  });

  it("rejects malformed definitions before quoting", () => {
    expect(() =>
      quoteDiscount(discount({ value: { kind: "percentage", basisPoints: 10_001 } }), {
        lines: [line(pro, "100")],
        now,
        redemptionCount: 0,
        customerRedemptionCount: 0,
      }),
    ).toThrow(/basis points/);
  });
});

function discount(overrides: Partial<Discount> = {}): Discount {
  return {
    id: parseId<"DiscountId">("disc_contract01", "disc"),
    code: "SAVE10",
    name: "Save ten percent",
    value: { kind: "percentage", basisPoints: 1000 },
    eligibleSkuIds: [],
    eligibleCustomerRefs: [],
    status: "active",
    createdAt: parseIsoDateTime("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function line(skuId: SkuId, amount: string) {
  return { skuId, subtotal: money(amount, "USD") };
}
