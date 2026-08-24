import type { MappingLookup } from "@polybill/adapter-kit";
import type { ConnectionId, TenantId } from "@polybill/core";

export interface ApplicationMappingStore {
  findCanonicalId(
    tenantId: TenantId,
    connectionId: ConnectionId,
    entityType: string,
    externalId: string,
  ): Promise<string | undefined>;
}

export function createApplicationStoreMappingLookup(store: ApplicationMappingStore): MappingLookup {
  return {
    findCanonicalId: (input) =>
      store.findCanonicalId(input.tenantId, input.connectionId, input.entityType, input.externalId),
  };
}
