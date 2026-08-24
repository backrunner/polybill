import {
  arrayField,
  invalid,
  invalidProviderImportCursor,
  object,
  unsupportedProviderImport,
  type ProviderImportEntityType,
  type ProviderMigrationSource,
} from "@polybill/adapter-kit";
import { creemRequest } from "./client.js";

const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const creemMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    const page = pageNumber(context, cursor);
    const query = new URLSearchParams({ page_number: String(page), page_size: "100" });
    const root = object(
      (await creemRequest(context, "GET", `${path(entityType)}?${query}`)).json(),
      "creem",
      "creem.migration.scan",
    );
    const items = arrayField(root, "items", "creem", "creem.migration.scan").map((item) =>
      object(item, "creem", "creem.migration.scan"),
    );
    const pagination = object(root.pagination, "creem", "creem.migration.scan");
    if (pagination.current_page !== page) invalid("creem", "creem.migration.scan");
    const next = pagination.next_page;
    if (
      next !== null &&
      next !== undefined &&
      (!Number.isSafeInteger(next) || Number(next) <= page)
    )
      invalid("creem", "creem.migration.scan");
    return {
      items,
      ...(next === null || next === undefined ? {} : { nextCursor: String(next) }),
    };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/v1/products/search",
    price: "/v1/products/search",
    customer: "/v1/customers/list",
    subscription: "/v1/subscriptions/search",
    payment: "/v1/transactions/search",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Creem migration entity");
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
