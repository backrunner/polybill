import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMoney, money, percentageOf, subtractMoney } from "../src/index.js";

describe("money", () => {
  it("never loses integer precision", () => {
    const left = money("900719925474099312345", "USD");
    const right = money("2", "USD");
    expect(addMoney(left, right).amount).toBe("900719925474099312347");
  });

  it("rejects currency mixing and negative results", () => {
    expect(() => addMoney(money("1", "USD"), money("1", "EUR"))).toThrow(/currencies/);
    expect(() => subtractMoney(money("1", "USD"), money("2", "USD"))).toThrow(/negative/);
  });

  it("rounds basis points deterministically", () => {
    expect(percentageOf(money("101", "USD"), 5000, "half_up").amount).toBe("51");
    expect(percentageOf(money("101", "USD"), 5000, "down").amount).toBe("50");
  });

  it("preserves addition/subtraction for arbitrary non-negative amounts", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n }), fc.bigInt({ min: 0n }), (a, b) => {
        const sum = addMoney(money(a.toString(), "USD"), money(b.toString(), "USD"));
        expect(subtractMoney(sum, money(b.toString(), "USD")).amount).toBe(a.toString());
      }),
    );
  });
});
