import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeCustomers: CustomerProvider = {
  async create(context, input) {
    const body = customerBody(input);
    body.set("metadata[polybill_customer_id]", input.externalReference);
    return stripeResult(
      context,
      decodeCustomer((await stripeRequest(context, "POST", "/v1/customers", body)).json()),
    );
  },
  async get(context, externalId) {
    return stripeResult(
      context,
      decodeCustomer(
        (
          await stripeRequest(context, "GET", `/v1/customers/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async update(context, externalId, input) {
    return stripeResult(
      context,
      decodeCustomer(
        (
          await stripeRequest(
            context,
            "POST",
            `/v1/customers/${encodeURIComponent(externalId)}`,
            customerBody(input),
          )
        ).json(),
      ),
    );
  },
  async tombstone(context, externalId) {
    return stripeResult(
      context,
      decodeCustomer(
        (
          await stripeRequest(context, "DELETE", `/v1/customers/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async portal(context, externalId, returnUrl) {
    const root = object(
      (
        await stripeRequest(
          context,
          "POST",
          "/v1/billing_portal/sessions",
          new URLSearchParams({ customer: externalId, return_url: returnUrl }),
        )
      ).json(),
      "stripe",
      "stripe.portal.decode",
    );
    return stripeResult(context, {
      externalId,
      url: stringField(root, "url", "stripe", "stripe.portal.decode"),
    });
  },
};

function customerBody(input: {
  readonly email?: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): URLSearchParams {
  const body = new URLSearchParams();
  if (input.email !== undefined) body.set("email", input.email);
  if (input.name !== undefined) body.set("name", input.name);
  for (const [key, value] of Object.entries(input.metadata ?? {}))
    body.set(`metadata[${key}]`, value);
  return body;
}

function decodeCustomer(value: unknown): ProviderCustomerSnapshot {
  const root = object(value, "stripe", "stripe.customer.decode");
  const deleted = root.deleted;
  const email = optionalString(root, "email");
  const name = optionalString(root, "name");
  return {
    externalId: stringField(root, "id", "stripe", "stripe.customer.decode"),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    status:
      deleted === true
        ? "tombstoned"
        : deleted === false || deleted === undefined
          ? "active"
          : "unknown",
  };
}
