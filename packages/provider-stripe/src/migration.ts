import {
  arrayField,
  invalid,
  invalidProviderImportCursor,
  object,
  stringField,
  unsupportedProviderImport,
  type ProviderImportEntityType,
  type ProviderMigrationSource,
} from "@polybill/adapter-kit";
import { stripeRequest } from "./client.js";

const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const stripeMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    if (cursor !== undefined && !/^[A-Za-z0-9_:-]{2,255}$/.test(cursor))
      throw invalidProviderImportCursor(context);
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("starting_after", cursor);
    if (entityType === "subscription") query.set("status", "all");
    const root = object(
      (await stripeRequest(context, "GET", `${path(entityType)}?${query}`)).json(),
      "stripe",
      "stripe.migration.scan",
    );
    const items = arrayField(root, "data", "stripe", "stripe.migration.scan").map((item) =>
      object(item, "stripe", "stripe.migration.scan"),
    );
    const hasMore = root.has_more;
    if (typeof hasMore !== "boolean") invalid("stripe", "stripe.migration.scan");
    const last = items.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? stringField(last, "id", "stripe", "stripe.migration.scan")
        : undefined;
    if (hasMore && nextCursor === undefined) invalid("stripe", "stripe.migration.scan");
    return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/v1/products",
    price: "/v1/prices",
    customer: "/v1/customers",
    subscription: "/v1/subscriptions",
    payment: "/v1/payment_intents",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Stripe migration entity");
  return value;
}
