import { describe, expect, it } from "vitest";
import { billingRate, priceUsage } from "../src/index.js";

describe("fractional minor-unit billing", () => {
  it("extends before rounding, including values beyond Number precision", () => {
    expect(
      priceUsage("1000", [{ unit: billingRate("0.001", "USD") }], "graduated", "half_up").amount,
    ).toBe("1");
    expect(
      priceUsage("9007199254740993", [{ unit: billingRate("1.25", "USD") }], "volume", "down")
        .amount,
    ).toBe("11258999068426241");
  });
  it.each([
    ["down", "2"],
    ["up", "3"],
    ["half_up", "3"],
    ["half_even", "2"],
  ] as const)("applies %s once at the invoice line boundary", (rounding, amount) => {
    expect(priceUsage("5", [{ unit: billingRate("0.5", "USD") }], "volume", rounding).amount).toBe(
      amount,
    );
  });
  it("distinguishes graduated and volume pricing and flat entry charges", () => {
    const tiers = [
      { upTo: "10", unit: billingRate("1.5", "USD"), flat: billingRate("2", "USD") },
      { unit: billingRate("0.5", "USD"), flat: billingRate("1", "USD") },
    ];
    expect(priceUsage("12", tiers, "graduated", "half_up").amount).toBe("19");
    expect(priceUsage("12", tiers, "volume", "half_up").amount).toBe("7");
    expect(priceUsage("0", tiers, "volume", "half_up").amount).toBe("0");
  });
  it.each(["-1", "1e-3", "NaN", "0.0000000000000000001", "01.1"])(
    "rejects invalid rate %s",
    (value) => {
      expect(() => billingRate(value, "USD")).toThrow();
    },
  );
  it("rejects gaps in coverage, descending tiers and mixed currency", () => {
    expect(() =>
      priceUsage("10", [{ upTo: "10", unit: billingRate("1", "USD") }], "volume", "up"),
    ).toThrow();
    expect(() =>
      priceUsage(
        "10",
        [
          { upTo: "10", unit: billingRate("1", "USD") },
          { upTo: "5", unit: billingRate("1", "USD") },
          { unit: billingRate("1", "USD") },
        ],
        "volume",
        "up",
      ),
    ).toThrow();
    expect(() =>
      priceUsage(
        "10",
        [{ unit: billingRate("1", "USD"), flat: billingRate("1", "EUR") }],
        "volume",
        "up",
      ),
    ).toThrow();
  });
});
