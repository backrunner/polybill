import type { CapabilitySnapshot } from "@polybill/adapter-kit";
import type { ConnectionId, IsoDateTime, TenantId } from "@polybill/core";

export type AdoptionMode =
  "observe_only" | "shadow_read" | "new_sales_cutover" | "dual_run" | "full_control";

export type MigrationPhase =
  | "analyzed"
  | "planned"
  | "dry_run"
  | "approved"
  | "applying"
  | "verifying"
  | "ready"
  | "blocked"
  | "failed"
  | "cutback";

export type MigrationEntityType =
  | "product"
  | "sku"
  | "price"
  | "customer"
  | "subscription"
  | "payment_method"
  | "payment"
  | "license"
  | "voucher";

export type MigrationAction =
  | "map_existing"
  | "create_target"
  | "update_target"
  | "archive_target"
  | "keep_source_pinned"
  | "request_reauthorization"
  | "provider_assisted"
  | "manual_review";

export interface MigrationSourceItem {
  readonly key: string;
  readonly entityType: MigrationEntityType;
  readonly sourceId: string;
  readonly canonicalId?: string;
  readonly targetExternalId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly active?: boolean;
  readonly paymentMethodKind?: "card" | "wallet" | "bank" | "crypto" | "unknown";
  readonly dependsOn?: readonly string[];
}

export interface MigrationLoss {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
  readonly blocking: boolean;
}

export interface MigrationPlanItem {
  readonly key: string;
  readonly entityType: MigrationEntityType;
  readonly sourceId: string;
  readonly canonicalId?: string;
  readonly targetExternalId?: string;
  readonly action: MigrationAction;
  readonly desired: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  readonly losses: readonly MigrationLoss[];
  readonly requiredHumanAction?: string;
  readonly rollback: "none" | "mapping_only" | "archive_created" | "source_pinned";
}

export interface MigrationPlan {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceConnectionId: ConnectionId;
  readonly targetConnectionId: ConnectionId;
  readonly mode: AdoptionMode;
  readonly phase: MigrationPhase;
  readonly sourceCapabilitiesHash: string;
  readonly targetCapabilitiesHash: string;
  readonly items: readonly MigrationPlanItem[];
  readonly losses: readonly MigrationLoss[];
  readonly createdAt: IsoDateTime;
}

export interface MigrationPlanInput {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceConnectionId: ConnectionId;
  readonly targetConnectionId: ConnectionId;
  readonly mode: AdoptionMode;
  readonly sourceCapabilities: CapabilitySnapshot;
  readonly targetCapabilities: CapabilitySnapshot;
  readonly items: readonly MigrationSourceItem[];
  readonly legalResponsibilityAcknowledged?: boolean;
  readonly allowProviderAssistedCards?: boolean;
  readonly allowProviderAssistedSubscriptions?: boolean;
  readonly createdAt: IsoDateTime;
}

export interface MigrationItemResult {
  readonly itemKey: string;
  readonly status: "skipped" | "mapped" | "created" | "updated" | "archived" | "failed";
  readonly externalId?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
}

export interface MigrationVerification {
  readonly itemKey: string;
  readonly status: "matched" | "different" | "missing" | "manual";
  readonly differences: readonly string[];
}

export interface MigrationReport {
  readonly planId: string;
  readonly phase: MigrationPhase;
  readonly totals: Readonly<Record<MigrationItemResult["status"], number>>;
  readonly results: readonly MigrationItemResult[];
  readonly verifications: readonly MigrationVerification[];
  readonly blockers: readonly MigrationLoss[];
}
