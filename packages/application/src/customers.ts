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

export interface UpdateCustomerCommand {
  readonly idempotencyKey: IdempotencyKey;
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
        const port = this.#runtime.options.adapter.customers?.create;
        if (port === undefined) throw unsupported("customer.create");
        const id = parseId<"CustomerId">(this.#runtime.options.ids.next("cust"), "cust");
        const remote = await port(context, {
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

  async update(id: CustomerId, command: UpdateCustomerCommand): Promise<Customer> {
    const current = await this.get(id);
    if (current === undefined) throw notFound("customer.update");
    return this.#runtime.mutate({
      operation: "customer.update",
      key: command.idempotencyKey,
      payload: { id, ...command },
      decodeReplay: decodeCustomer,
      execute: async (context) => {
        await this.#runtime.requireCapability("customer.update", context);
        const port = this.#runtime.options.adapter.customers?.update;
        if (port === undefined) throw unsupported("customer.update");
        const externalId = await this.#externalId(id, "customer.update");
        const remote = await port(context, externalId, {
          ...(command.email === undefined ? {} : { email: command.email }),
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
        });
        const customer: Customer = {
          ...current,
          ...(command.email === undefined ? {} : { email: command.email }),
          ...(command.name === undefined ? {} : { name: command.name }),
          status: remote.value.status === "tombstoned" ? "tombstoned" : current.status,
        };
        await this.#commit(customer, externalId, remote.evidence);
        return customer;
      },
    });
  }

  async refresh(id: CustomerId, idempotencyKey: IdempotencyKey): Promise<Customer> {
    const current = await this.get(id);
    if (current === undefined) throw notFound("customer.read");
    return this.#runtime.mutate({
      operation: "customer.refresh",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeCustomer,
      execute: async (context) => {
        await this.#runtime.requireCapability("customer.read", context);
        const port = this.#runtime.options.adapter.customers?.get;
        if (port === undefined) throw unsupported("customer.read");
        const externalId = await this.#externalId(id, "customer.read");
        const remote = await port(context, externalId);
        if (remote.value.status === "unknown")
          throw new PolybillError("Provider returned an unknown customer status", {
            code: "provider_response_invalid",
            operation: "customer.read",
            retryable: false,
          });
        const customer: Customer = {
          ...current,
          ...(remote.value.email === undefined ? {} : { email: remote.value.email }),
          ...(remote.value.name === undefined ? {} : { name: remote.value.name }),
          status: remote.value.status,
        };
        await this.#commit(customer, externalId, remote.evidence);
        return customer;
      },
    });
  }

  async tombstone(id: CustomerId, idempotencyKey: IdempotencyKey): Promise<Customer> {
    const current = await this.get(id);
    if (current === undefined) throw notFound("customer.delete");
    return this.#runtime.mutate({
      operation: "customer.delete",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeCustomer,
      execute: async (context) => {
        await this.#runtime.requireCapability("customer.delete", context);
        const port = this.#runtime.options.adapter.customers?.tombstone;
        if (port === undefined) throw unsupported("customer.delete");
        const externalId = await this.#externalId(id, "customer.delete");
        const remote = await port(context, externalId);
        const customer: Customer = { ...current, status: "tombstoned" };
        await this.#commit(customer, externalId, remote.evidence);
        return customer;
      },
    });
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

  async #externalId(id: CustomerId, operation: string): Promise<string> {
    return requireExternalId(
      await this.#runtime.options.store.getExternalId(
        this.#runtime.options.tenantId,
        this.#runtime.options.connection.id,
        "customer",
        id,
      ),
      operation,
    );
  }

  async #commit(customer: Customer, externalId: string, evidence: unknown): Promise<void> {
    await this.#runtime.options.store.commitResource({
      tenantId: this.#runtime.options.tenantId,
      connectionId: this.#runtime.options.connection.id,
      provider: this.#runtime.options.connection.provider,
      entityType: "customer",
      entityId: customer.id,
      externalId,
      value: customer,
      evidence,
      occurredAt: this.#runtime.options.clock.now(),
    });
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
function notFound(operation: string): PolybillError {
  return new PolybillError("Canonical customer was not found", {
    code: "not_found",
    operation,
    retryable: false,
  });
}
