import type { ProviderContext } from "./context.js";
import { PolybillError } from "@polybill/core";

export type ProviderImportEntityType =
  | "product"
  | "sku"
  | "price"
  | "customer"
  | "subscription"
  | "payment_method"
  | "payment"
  | "license"
  | "voucher";

export interface ProviderImportPage {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor?: string;
}

export interface ProviderMigrationSource {
  readonly supportedEntityTypes: readonly ProviderImportEntityType[];
  scan(
    context: ProviderContext,
    entityType: ProviderImportEntityType,
    cursor?: string,
  ): Promise<ProviderImportPage>;
}

export function unsupportedProviderImport(
  context: ProviderContext,
  entityType: ProviderImportEntityType,
): PolybillError {
  return new PolybillError(`Provider source import does not support ${entityType}`, {
    code: "unsupported_capability",
    operation: `${context.connection.provider}.migration.scan`,
    provider: context.connection.provider,
    connectionId: context.connection.id,
    retryable: false,
  });
}

export function invalidProviderImportCursor(context: ProviderContext): PolybillError {
  return new PolybillError("Provider migration cursor is invalid", {
    code: "invalid_request",
    operation: `${context.connection.provider}.migration.scan`,
    provider: context.connection.provider,
    connectionId: context.connection.id,
    retryable: false,
  });
}
