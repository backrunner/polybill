import { PolybillError, type Environment } from "@polybill/core";
import type { ProviderContext } from "./context.js";

/**
 * Providers whose secrets do not carry a public test/live prefix may still
 * bind an explicit `environment` credential. When present, reject a mismatch
 * before any network request; omission preserves provider-native secret forms.
 */
export function assertCredentialEnvironment(
  context: Pick<ProviderContext, "credentials" | "connection">,
  operation: string,
): void {
  const declared = context.credentials.environment;
  if (declared !== undefined && declared !== context.connection.environment) {
    throw new PolybillError("Credential environment does not match the connection", {
      code: "authentication_failed",
      operation,
      provider: context.connection.provider,
      connectionId: context.connection.id,
      retryable: false,
    });
  }
}

export function credentialEnvironment(value: string | undefined): Environment | undefined {
  return value === "test" || value === "live" ? value : undefined;
}
