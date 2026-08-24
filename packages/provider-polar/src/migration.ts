import {
  arrayField,
  invalid,
  invalidProviderImportCursor,
  object,
  unsupportedProviderImport,
  type ProviderImportEntityType,
  type ProviderMigrationSource,
} from "@polybill/adapter-kit";
import { polarRequest } from "./client.js";

const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const polarMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    const requestedPage = pageNumber(context, cursor);
    const query = new URLSearchParams({ page: String(requestedPage), limit: "100" });
    const root = object(
      (await polarRequest(context, "GET", `${path(entityType)}?${query}`)).json(),
      "polar",
      "polar.migration.scan",
    );
    const items = arrayField(root, "items", "polar", "polar.migration.scan").map((item) =>
      object(item, "polar", "polar.migration.scan"),
    );
    const pagination = object(root.pagination, "polar", "polar.migration.scan");
    if (
      !Number.isSafeInteger(pagination.total_count) ||
      Number(pagination.total_count) < 0 ||
      !Number.isSafeInteger(pagination.max_page) ||
      Number(pagination.max_page) < requestedPage
    )
      invalid("polar", "polar.migration.scan");
    return {
      items,
      ...(Number(pagination.max_page) === requestedPage
        ? {}
        : { nextCursor: String(requestedPage + 1) }),
    };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/v1/products/",
    price: "/v1/products/",
    customer: "/v1/customers/",
    subscription: "/v1/subscriptions/",
    payment: "/v1/orders/",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Polar migration entity");
  return value;
}

function pageNumber(
  context: Parameters<ProviderMigrationSource["scan"]>[0],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]{0,8}$/.test(cursor)) throw invalidProviderImportCursor(context);
  return Number(cursor);
}
