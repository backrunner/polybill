import {
  arrayField,
  invalid,
  invalidProviderImportCursor,
  object,
  unsupportedProviderImport,
  type ProviderImportEntityType,
  type ProviderMigrationSource,
} from "@polybill/adapter-kit";
import { lemonRequest } from "./client.js";

const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const lemonMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    const requestedPage = pageNumber(context, cursor);
    const query = new URLSearchParams({
      "page[number]": String(requestedPage),
      "page[size]": "100",
    });
    const root = object(
      (await lemonRequest(context, "GET", `${path(entityType)}?${query}`)).json(),
      "lemonSqueezy",
      "lemonSqueezy.migration.scan",
    );
    const items = arrayField(root, "data", "lemonSqueezy", "lemonSqueezy.migration.scan").map(
      (item) => object(item, "lemonSqueezy", "lemonSqueezy.migration.scan"),
    );
    const meta = object(root.meta, "lemonSqueezy", "lemonSqueezy.migration.scan");
    const page = object(meta.page, "lemonSqueezy", "lemonSqueezy.migration.scan");
    const current = page.currentPage;
    const last = page.lastPage;
    if (current !== requestedPage || !Number.isSafeInteger(last) || Number(last) < requestedPage)
      invalid("lemonSqueezy", "lemonSqueezy.migration.scan");
    return {
      items,
      ...(Number(last) === requestedPage ? {} : { nextCursor: String(requestedPage + 1) }),
    };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/products",
    price: "/variants",
    customer: "/customers",
    subscription: "/subscriptions",
    payment: "/orders",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Lemon Squeezy migration entity");
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
