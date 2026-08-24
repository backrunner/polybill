import { describe, expect, it } from "vitest";
import { money, parseId, transitionPayment, type Payment } from "../src/index.js";

function payment(status: Payment["status"]): Payment {
  return {
    id: parseId<"PaymentId">("pay_000001", "pay"),
    orderId: parseId<"OrderId">("ord_000001", "ord"),
    status,
    amount: money("1000", "USD"),
    refundedAmount: money("0", "USD"),
    evidence: [],
  };
}

describe("payment state", () => {
  it("accepts forward progress and idempotent observations", () => {
    const processing = transitionPayment(payment("pending"), "processing");
    expect(transitionPayment(processing, "processing")).toBe(processing);
    expect(transitionPayment(processing, "succeeded").status).toBe("succeeded");
  });

  it("does not reopen terminal attempts", () => {
    expect(() => transitionPayment(payment("succeeded"), "processing")).toThrow(/Invalid/);
  });
});
