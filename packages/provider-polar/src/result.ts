import type { ProviderContext, ProviderOperationResult } from "@polybill/adapter-kit";

export function polarResult<T extends { readonly externalId: string; readonly rawStatus?: string }>(
  context: ProviderContext,
  value: T,
): ProviderOperationResult<T> {
  return {
    value,
    evidence: {
      provider: "polar",
      environment: context.connection.environment,
      externalId: value.externalId,
      observedAt: context.clock.now(),
      ...(value.rawStatus === undefined ? {} : { rawStatus: value.rawStatus }),
    },
    idempotency: "both",
    warnings: [],
  };
}
