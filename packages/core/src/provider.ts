import type { ConnectionId, TenantId } from "./ids.js";

export type ProviderName =
  "stripe" | "dodo" | "polar" | "creem" | "waffo" | "lemonSqueezy" | "paddle" | "x402" | "fake";

export type Environment = "test" | "live";

export interface ConnectionRef {
  readonly id: ConnectionId;
  readonly tenantId: TenantId;
  readonly provider: ProviderName;
  readonly environment: Environment;
  readonly accountRef?: string;
}
