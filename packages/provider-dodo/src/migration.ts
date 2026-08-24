import {
  arrayField,
  invalidProviderImportCursor,
  object,
  unsupportedProviderImport,
  type ProviderImportEntityType,
  type ProviderMigrationSource,
} from "@polybill/adapter-kit";
import { dodoRequest } from "./client.js";

// Dodo's generated SDK advances page_number until an empty items page.
const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const dodoMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    const page = pageNumber(context, cursor);
    const query = new URLSearchParams({ page_number: String(page), page_size: "100" });
    const root = object(
      (await dodoRequest(context, "GET", `${path(entityType)}?${query}`)).json(),
      "dodo",
      "dodo.migration.scan",
    );
    const items = arrayField(root, "items", "dodo", "dodo.migration.scan").map((item) =>
      object(item, "dodo", "dodo.migration.scan"),
    );
    return {
      items,
      ...(items.length === 0 ? {} : { nextCursor: String(page + 1) }),
    };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/products",
    price: "/products",
    customer: "/customers",
    subscription: "/subscriptions",
    payment: "/payments",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Dodo migration entity");
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
