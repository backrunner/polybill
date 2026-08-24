import {
  object,
  optionalString,
  stringField,
  type CustomerProvider,
  type ProviderCustomerSnapshot,
} from "@polybill/adapter-kit";
import { paddleRequest } from "./client.js";
import { paddleResult } from "./result.js";

export const paddleCustomers: CustomerProvider = {
  async create(context, input) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "POST", "/customers", {
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.name === undefined ? {} : { name: input.name }),
            custom_data: { ...input.metadata, polybill_customer_id: input.externalReference },
          })
        ).json(),
      ),
    );
  },
  async get(context, externalId) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "GET", `/customers/${encodeURIComponent(externalId)}`)
        ).json(),
      ),
    );
  },
  async update(context, externalId, input) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "PATCH", `/customers/${encodeURIComponent(externalId)}`, {
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.metadata === undefined ? {} : { custom_data: input.metadata }),
          })
        ).json(),
      ),
    );
  },
  async tombstone(context, externalId) {
    return paddleResult(
      context,
      decode(
        (
          await paddleRequest(context, "PATCH", `/customers/${encodeURIComponent(externalId)}`, {
            status: "archived",
          })
        ).json(),
      ),
    );
  },
  async portal(context, externalId) {
    const root = object(
      (
        await paddleRequest(
          context,
          "POST",
          `/customers/${encodeURIComponent(externalId)}/portal-sessions`,
          {},
        )
      ).json(),
      "paddle",
      "paddle.portal.decode",
    );
    const data = object(root.data, "paddle", "paddle.portal.decode");
    const urls = object(data.urls, "paddle", "paddle.portal.decode");
    const general = object(urls.general, "paddle", "paddle.portal.decode");
    return paddleResult(context, {
      externalId,
      url: stringField(general, "overview", "paddle", "paddle.portal.decode"),
    });
  },
};

function decode(value: unknown): ProviderCustomerSnapshot {
  const root = object(
    object(value, "paddle", "paddle.customer.decode").data,
    "paddle",
    "paddle.customer.decode",
  );
  const email = optionalString(root, "email");
  const name = optionalString(root, "name");
  const status = optionalString(root, "status");
  return {
    externalId: stringField(root, "id", "paddle", "paddle.customer.decode"),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    status: status === "archived" ? "tombstoned" : status === "active" ? "active" : "unknown",
  };
}
