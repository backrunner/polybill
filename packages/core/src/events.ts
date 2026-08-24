import type { ConnectionId, EventId, EvidenceId, TenantId } from "./ids.js";
import type { Environment } from "./provider.js";
import type { IsoDateTime } from "./time.js";

export interface CanonicalBillingEvent<Type extends string = string, Data = unknown> {
  readonly id: EventId;
  readonly schemaVersion: 1;
  readonly type: Type;
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly environment: Environment;
  readonly aggregate: { readonly type: string; readonly id: string };
  readonly occurredAt: IsoDateTime;
  readonly observedAt: IsoDateTime;
  readonly data: Data;
  readonly evidenceRef: EvidenceId;
}
