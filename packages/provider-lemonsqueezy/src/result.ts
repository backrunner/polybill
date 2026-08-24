import type { ProviderContext, ProviderOperationResult } from "@polybill/adapter-kit";

export function lemonResult<T extends { readonly externalId: string; readonly rawStatus?: string }>(
  context: ProviderContext,
  value: T,
): ProviderOperationResult<T> {
  return {
    value,
    evidence: {
      provider: "lemonSqueezy",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      ...(value.rawStatus === undefined ? {} : { rawStatus: value.rawStatus }),
    },
    idempotency: "polybill",
    warnings: [],
  };
}
