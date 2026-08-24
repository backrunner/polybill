import type {
  CheckoutId,
  CheckoutSession,
  Order,
  OrderId,
  Payment,
  PaymentId,
} from "@polybill/core";
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

  order(id: OrderId): Promise<Order | undefined> {
    return resource(this.#runtime.options.store, this.#runtime.options.tenantId, "order", id);
  }

  payment(id: PaymentId): Promise<Payment | undefined> {
    return resource(this.#runtime.options.store, this.#runtime.options.tenantId, "payment", id);
  }
}

function resource<T>(
  store: ApplicationStore,
  tenantId: ResourceRuntime["options"]["tenantId"],
  type: string,
  id: string,
): Promise<T | undefined> {
  return store.getResource(tenantId, type, id);
}
