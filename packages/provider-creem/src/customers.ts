import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { creemRequest } from "./client.js";
import { creemResult } from "./result.js";

export const creemCustomers: CustomerProvider = {
  async create(context, input) {
    if (input.email === undefined)
      throw unsupported(context, "Creem customer creation requires email");
    return creemResult(
      context,
      decode(
        (
          await creemRequest(context, "POST", "/v1/customers", {
            email: input.email,
            ...(input.name === undefined ? {} : { name: input.name }),
            external_id: input.externalReference,
            metadata: {
              ...input.metadata,
              polybill_customer_id: input.externalReference,
            },
          })
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    const query = new URLSearchParams({ customer_id: externalId });
    return creemResult(
      context,
      decode((await creemRequest(context, "GET", `/v1/customers?${query.toString()}`)).json()),
    );
  },
  async update(context, externalId, input) {
    if (input.email !== undefined)
      throw unsupported(context, "Creem does not allow customer email updates");
    return creemResult(
      context,
      decode(
        (
          await creemRequest(context, "PATCH", "/v1/customers", {
            customer_id: externalId,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          })
        ).json(),
      ),
    );
  },
  async portal(context, externalId) {
    const root = object(
      (
        await creemRequest(context, "POST", "/v1/customers/billing", {
          customer_id: externalId,
        })
      ).json(),
      "creem",
      "creem.customer.portal.decode",
    );
    return creemResult(context, {
      externalId,
      url: stringField(root, "customer_portal_link", "creem", "creem.customer.portal.decode"),
    });
  },
};

function decode(value: unknown): ProviderCustomerSnapshot {
  const root = object(value, "creem", "creem.customer.decode");
  const email = optionalString(root, "email");
  const name = optionalString(root, "name");
  return {
    externalId: stringField(root, "id", "creem", "creem.customer.decode"),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    status: "active",
  };
}

function unsupported(
  context: Parameters<NonNullable<CustomerProvider["create"]>>[0],
  message: string,
) {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "creem.customer",
    provider: "creem",
    connectionId: context.connection.id,
    retryable: false,
  });
}
