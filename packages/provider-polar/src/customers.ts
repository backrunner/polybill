import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import { polarRequest, type PolarRequest } from "./client.js";
import { polarResult } from "./result.js";

export function createPolarCustomers(request: PolarRequest = polarRequest): CustomerProvider {
  return {
    async create(context, input) {
      if (input.email === undefined)
        throw unsupported(context, "Polar individual customer creation requires an email");
      return polarResult(
        context,
        decode(
          (
            await request(context, "POST", "/v1/customers/", {
              type: "individual",
              email: input.email,
              ...(input.name === undefined ? {} : { name: input.name }),
              external_id: input.externalReference,
              metadata: input.metadata,
            })
          ).json(),
        ),
      );
    },
    async get(context, externalId) {
      return polarResult(
        context,
        decode(
          (await request(context, "GET", `/v1/customers/${encodeURIComponent(externalId)}`)).json(),
        ),
      );
    },
    async update(context, externalId, input) {
      return polarResult(
        context,
        decode(
          (
            await request(context, "PATCH", `/v1/customers/${encodeURIComponent(externalId)}`, {
              ...(input.email === undefined ? {} : { email: input.email }),
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            })
          ).json(),
        ),
      );
    },
    async tombstone(context, externalId) {
      await request(
        context,
        "DELETE",
        `/v1/customers/${encodeURIComponent(externalId)}?anonymize=true`,
      );
      return polarResult(context, { externalId, status: "tombstoned" });
    },
    async portal(context, externalId, returnUrl) {
      const root = object(
        (
          await request(context, "POST", "/v1/customer-sessions/", {
            customer_id: externalId,
            return_url: returnUrl,
          })
        ).json(),
        "polar",
        "polar.customer.portal.decode",
      );
      const expiresAt = optionalString(root, "expires_at");
      return polarResult(context, {
        externalId,
        url: stringField(root, "customer_portal_url", "polar", "polar.customer.portal.decode"),
        ...(expiresAt === undefined ? {} : { expiresAt: parseIsoDateTime(expiresAt) }),
      });
    },
  };
}

function decode(value: unknown): ProviderCustomerSnapshot {
  const root = object(value, "polar", "polar.customer.decode");
  const email = optionalString(root, "email");
  const name = optionalString(root, "name");
  return {
    externalId: stringField(root, "id", "polar", "polar.customer.decode"),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    status: root.deleted_at === null || root.deleted_at === undefined ? "active" : "tombstoned",
  };
}

function unsupported(
  context: Parameters<NonNullable<CustomerProvider["create"]>>[0],
  message: string,
) {
  return new PolybillError(message, {
    code: "unsupported_capability",
    operation: "polar.customer",
    provider: "polar",
    connectionId: context.connection.id,
    retryable: false,
  });
}
