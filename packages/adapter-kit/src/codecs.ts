import { PolybillError, type ProviderName } from "@polybill/core";

export type JsonObject = Readonly<Record<string, unknown>>;

export function object(value: unknown, provider: ProviderName, operation: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(provider, operation);
  return value as JsonObject;
}

export function stringField(
  value: JsonObject,
  key: string,
  provider: ProviderName,
  operation: string,
): string {
  const field = value[key];
  if (typeof field !== "string") throw invalid(provider, operation);
  return field;
}

export function optionalString(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function arrayField(
  value: JsonObject,
  key: string,
  provider: ProviderName,
  operation: string,
): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw invalid(provider, operation);
  return field;
}

export function invalid(provider: ProviderName, operation: string): PolybillError {
  return new PolybillError("Provider response did not match the pinned schema", {
    code: "provider_response_invalid",
    operation,
    provider,
    retryable: false,
  });
}
