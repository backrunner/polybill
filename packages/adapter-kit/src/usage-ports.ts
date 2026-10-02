import type { IsoDateTime, UsageMeter } from "@polybill/core";
import type { ProviderContext } from "./context.js";
import type { ProviderOperationResult } from "./ports.js";

export interface ProviderUsageEvent {
  readonly externalId: string;
  readonly externalCustomerId: string;
  readonly meter: UsageMeter;
  readonly quantity: string;
  readonly occurredAt: IsoDateTime;
}
export interface UsageProvider {
  validateEvent?(context: ProviderContext, event: ProviderUsageEvent): void;
  createMeter(
    context: ProviderContext,
    meter: UsageMeter,
  ): Promise<ProviderOperationResult<{ readonly externalId: string }>>;
  ingest(context: ProviderContext, event: ProviderUsageEvent): Promise<void>;
  /** Return true only after matching the complete original event, never merely its ID. */
  findEvent?(context: ProviderContext, event: ProviderUsageEvent): Promise<boolean>;
}
