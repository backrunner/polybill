import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { dodoRequest } from "./client.js";
import { dodoResult } from "./result.js";

export const dodoCustomers: CustomerProvider = {
  async create(context, input) {
    if (input.email === undefined || input.name === undefined)
      throw unsupported(context, "Dodo customer creation requires email and name");
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "POST", "/customers", {
            email: input.email,
            name: input.name,
            metadata: { ...input.metadata, polybill_customer_id: input.externalReference },
          })
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    return dodoResult(
      context,
      decode(
        (await dodoRequest(context, "GET", `/customers/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
  async update(context, externalId, input) {
    return dodoResult(
      context,
      decode(
        (
          await dodoRequest(context, "PATCH", `/customers/${encodeURIComponent(externalId)}`, {
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          })
        ).json(),
      ),
    );
  },
  async portal(context, externalId, returnUrl) {
    const query = new URLSearchParams({ return_url: returnUrl, send_email: "false" });
    const root = object(
      (
        await dodoRequest(
          context,
          "POST",
          `/customers/${encodeURIComponent(externalId)}/customer-portal/session?${query.toString()}`,
        )
      ).json(),
      "dodo",
      "dodo.customer.portal.decode",
    );
    return dodoResult(context, {
      externalId,
      url: stringField(root, "link", "dodo", "dodo.customer.portal.decode"),
    });
  },
};

function decode(value: unknown): ProviderCustomerSnapshot {
  const root = object(value, "dodo", "dodo.customer.decode");
  const email = optionalString(root, "email");
  const name = optionalString(root, "name");
  return {
    externalId: stringField(root, "customer_id", "dodo", "dodo.customer.decode"),
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
    operation: "dodo.customer",
    provider: "dodo",
    connectionId: context.connection.id,
    retryable: false,
  });
}
