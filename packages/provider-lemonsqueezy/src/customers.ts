import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { lemonRequest } from "./client.js";
import { lemonResult } from "./result.js";

export const lemonCustomers: CustomerProvider = {
  async get(context, externalId) {
    return lemonResult(
      context,
      decode(
        (await lemonRequest(context, "GET", `/customers/${encodeURIComponent(externalId)}`)).json(),
      ),
    );
  },
  async update(context, externalId, input) {
    return lemonResult(
      context,
      decode(
        (
          await lemonRequest(context, "PATCH", `/customers/${encodeURIComponent(externalId)}`, {
            data: {
              type: "customers",
              id: externalId,
              attributes: {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.email === undefined ? {} : { email: input.email }),
                ...(input.metadata === undefined ? {} : { custom_data: input.metadata }),
              },
            },
          })
        ).json(),
      ),
    );
  },
  async portal(context, externalId) {
    const root = jsonApiData(
      (await lemonRequest(context, "GET", `/customers/${encodeURIComponent(externalId)}`)).json(),
      "lemonSqueezy.customer.portal.decode",
    );
    const attributes = object(
      root.attributes,
      "lemonSqueezy",
      "lemonSqueezy.customer.portal.decode",
    );
    const urls = object(attributes.urls, "lemonSqueezy", "lemonSqueezy.customer.portal.decode");
    return lemonResult(context, {
      externalId,
      url: stringField(
        urls,
        "customer_portal",
        "lemonSqueezy",
        "lemonSqueezy.customer.portal.decode",
      ),
    });
  },
};

function decode(value: unknown): ProviderCustomerSnapshot {
  const root = jsonApiData(value, "lemonSqueezy.customer.decode");
  const attributes = object(root.attributes, "lemonSqueezy", "lemonSqueezy.customer.decode");
  const email = optionalString(attributes, "email");
  const name = optionalString(attributes, "name");
  return {
    externalId: stringField(root, "id", "lemonSqueezy", "lemonSqueezy.customer.decode"),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    status: "active",
  };
}

function jsonApiData(value: unknown, operation: string) {
  return object(object(value, "lemonSqueezy", operation).data, "lemonSqueezy", operation);
}
