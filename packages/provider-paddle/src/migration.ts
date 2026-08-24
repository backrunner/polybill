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
import { paddleRequest } from "./client.js";

const supported = ["product", "price", "customer", "subscription", "payment"] as const;

export const paddleMigration: ProviderMigrationSource = {
  supportedEntityTypes: supported,
  async scan(context, entityType, cursor) {
    if (!supported.includes(entityType as (typeof supported)[number]))
      throw unsupportedProviderImport(context, entityType);
    if (cursor !== undefined && !/^[A-Za-z0-9_-]{2,255}$/.test(cursor))
      throw invalidProviderImportCursor(context);
    const query = new URLSearchParams({ per_page: "100" });
    if (cursor !== undefined) query.set("after", cursor);
    const pathname = path(entityType);
    const root = object(
      (await paddleRequest(context, "GET", `${pathname}?${query}`)).json(),
      "paddle",
      "paddle.migration.scan",
    );
    const items = arrayField(root, "data", "paddle", "paddle.migration.scan").map((item) =>
      object(item, "paddle", "paddle.migration.scan"),
    );
    const meta = object(root.meta, "paddle", "paddle.migration.scan");
    const pagination = object(meta.pagination, "paddle", "paddle.migration.scan");
    if (typeof pagination.has_more !== "boolean") invalid("paddle", "paddle.migration.scan");
    const nextCursor = pagination.has_more
      ? cursorFromNext(
          context,
          stringField(pagination, "next", "paddle", "paddle.migration.scan"),
          pathname,
        )
      : undefined;
    return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
  },
};

function path(entityType: ProviderImportEntityType): string {
  const paths: Partial<Record<ProviderImportEntityType, string>> = {
    product: "/products",
    price: "/prices",
    customer: "/customers",
    subscription: "/subscriptions",
    payment: "/transactions",
  };
  const value = paths[entityType];
  if (value === undefined) throw new TypeError("Unsupported Paddle migration entity");
  return value;
}

function cursorFromNext(
  context: Parameters<ProviderMigrationSource["scan"]>[0],
  next: string,
  pathname: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    throw invalidProviderImportCursor(context);
  }
  const expectedOrigin =
    context.connection.environment === "test"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";
  const after = parsed.searchParams.get("after");
  if (
    parsed.origin !== expectedOrigin ||
    parsed.pathname !== pathname ||
    after === null ||
    !/^[A-Za-z0-9_-]{2,255}$/.test(after)
  )
    throw invalidProviderImportCursor(context);
  return after;
}
