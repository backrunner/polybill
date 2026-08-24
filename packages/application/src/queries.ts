import type {
  CheckoutId,
  CheckoutSession,
  Order,
  OrderId,
  Payment,
  PaymentId,
} from "@polybill/core";
import { money } from "@polybill/core";
import type { ApplicationStore } from "./ports.js";
import type { ResourceRuntime } from "./resource-runtime.js";

export class CommerceQueryService {
  readonly #runtime: ResourceRuntime;
  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  checkout(id: CheckoutId): Promise<CheckoutSession | undefined> {
    return this.#runtime.options.store.getCheckout(this.#runtime.options.tenantId, id);
  }

  async order(id: OrderId): Promise<Order | undefined> {
    const value = await resource<unknown>(
      this.#runtime.options.store,
      this.#runtime.options.tenantId,
      "order",
      id,
    );
    return value === undefined ? undefined : normalizeOrder(value);
  }

  payment(id: PaymentId): Promise<Payment | undefined> {
    return resource(this.#runtime.options.store, this.#runtime.options.tenantId, "payment", id);
  }
}

function normalizeOrder(value: unknown): Order {
  if (!record(value) || !moneyRecord(value.total))
    throw new TypeError("Stored canonical order is invalid");
  if (
    value.grossTotal === undefined &&
    value.discounts === undefined &&
    value.discountTotal === undefined
  )
    return {
      ...(value as unknown as Order),
      grossTotal: money(value.total.amount, value.total.currency),
      discounts: [],
      discountTotal: money("0", value.total.currency),
    };
  if (
    !moneyRecord(value.grossTotal) ||
    !Array.isArray(value.discounts) ||
    !moneyRecord(value.discountTotal)
  )
    throw new TypeError("Stored canonical order discount snapshot is invalid");
  return value as unknown as Order;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moneyRecord(
  value: unknown,
): value is { readonly amount: string; readonly currency: string } {
  return record(value) && typeof value.amount === "string" && typeof value.currency === "string";
}

function resource<T>(
  store: ApplicationStore,
  tenantId: ResourceRuntime["options"]["tenantId"],
  type: string,
  id: string,
): Promise<T | undefined> {
  return store.getResource(tenantId, type, id);
}
