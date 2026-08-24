import {
  PolybillError,
  parseId,
  type Customer,
  type CustomerId,
  type IdempotencyKey,
} from "@polybill/core";
import { validatedRedirectUrl } from "./checkout-helpers.js";
import { requireExternalId } from "./resource-runtime.js";
import type { ResourceRuntime } from "./resource-runtime.js";

export interface CreateCustomerCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly externalId: string;
  readonly email?: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class CustomerService {
  readonly #runtime: ResourceRuntime;
  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async create(command: CreateCustomerCommand): Promise<Customer> {
    if (command.externalId.length < 1 || command.externalId.length > 255)
      throw new TypeError("Invalid customer external ID");
    return this.#runtime.mutate({
      operation: "customer.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeCustomer,
      execute: async (context) => {
        await this.#runtime.requireCapability("customer.create", context);
        const port = this.#runtime.options.adapter.customers;
        if (port === undefined) throw unsupported("customer.create");
        const id = parseId<"CustomerId">(this.#runtime.options.ids.next("cust"), "cust");
        const remote = await port.create(context, {
          ...(command.email === undefined ? {} : { email: command.email }),
          ...(command.name === undefined ? {} : { name: command.name }),
          externalReference: id,
          metadata: command.metadata ?? {},
        });
        const customer: Customer = {
          id,
          externalId: command.externalId,
          ...(command.email === undefined ? {} : { email: command.email }),
          ...(command.name === undefined ? {} : { name: command.name }),
          status: remote.value.status === "tombstoned" ? "tombstoned" : "active",
        };
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "customer",
          entityId: customer.id,
          externalId: remote.value.externalId,
          value: customer,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return customer;
      },
    });
  }

  get(id: CustomerId): Promise<Customer | undefined> {
    return this.#runtime.options.store.getResource(this.#runtime.options.tenantId, "customer", id);
  }

  async portal(id: CustomerId, returnUrl: string) {
    const context = await this.#runtime.context();
    await this.#runtime.requireCapability("customer.portal", context);
    const port = this.#runtime.options.adapter.customers?.portal;
    if (port === undefined) throw unsupported("customer.portal");
    const externalId = requireExternalId(
      await this.#runtime.options.store.getExternalId(
        this.#runtime.options.tenantId,
        this.#runtime.options.connection.id,
        "customer",
        id,
      ),
      "customer.portal",
    );
    const result = await port(context, externalId, validatedRedirectUrl(returnUrl));
    return { provider: this.#runtime.options.connection.provider, ...result.value };
  }
}

function decodeCustomer(value: unknown): Customer {
  if (typeof value !== "object" || value === null || !("id" in value) || !("externalId" in value))
    throw new TypeError("Stored customer replay is invalid");
  return value as Customer;
}
function unsupported(operation: string): PolybillError {
  return new PolybillError("Provider customer capability is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}
