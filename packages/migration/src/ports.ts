import type { CanonicalBillingEvent, CustomerId } from "@polybill/core";
import type {
  ProviderImportPage,
  ProviderMigrationSource,
  ProviderContext,
} from "@polybill/adapter-kit";
import type {
  AdoptionMode,
  MigrationEntityType,
  MigrationItemResult,
  MigrationPlan,
  MigrationPlanItem,
  MigrationReport,
  MigrationVerification,
} from "./types.js";

export type MigrationPage = ProviderImportPage;

export interface ProviderSourceScanner {
  scan(entityType: MigrationEntityType, cursor?: string): Promise<MigrationPage>;
}

export function bindProviderSourceScanner(
  source: ProviderMigrationSource,
  context: ProviderContext,
): ProviderSourceScanner {
  return {
    scan: (entityType, cursor) => source.scan(context, entityType, cursor),
  };
}

export interface MigrationTarget {
  preview(item: MigrationPlanItem): Promise<{
    readonly externalId?: string;
    readonly current?: Readonly<Record<string, unknown>>;
    readonly differences: readonly string[];
  }>;
  create(
    item: MigrationPlanItem,
    idempotencyKey: string,
  ): Promise<{
    readonly externalId: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }>;
  update(
    item: MigrationPlanItem,
    idempotencyKey: string,
  ): Promise<{
    readonly externalId: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }>;
  archive(
    item: MigrationPlanItem,
    idempotencyKey: string,
  ): Promise<{
    readonly externalId: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }>;
  verify(item: MigrationPlanItem, externalId?: string): Promise<MigrationVerification>;
}

export type MigrationItemClaim =
  | { readonly kind: "claimed"; readonly leaseToken: string }
  | { readonly kind: "completed" }
  | { readonly kind: "in_progress" };

export interface MigrationStore {
  savePlan(plan: MigrationPlan): Promise<void>;
  getPlan(planId: string): Promise<MigrationPlan | undefined>;
  claimItem(planId: string, itemKey: string): Promise<MigrationItemClaim>;
  completeItem(planId: string, leaseToken: string, result: MigrationItemResult): Promise<void>;
  failItem(planId: string, itemKey: string, leaseToken: string, errorCode: string): Promise<void>;
  listResults(planId: string): Promise<readonly MigrationItemResult[]>;
  saveReport(report: MigrationReport): Promise<void>;
  getReport(planId: string): Promise<MigrationReport | undefined>;
  saveCheckpoint(
    planId: string,
    stream: string,
    cursor: string | undefined,
    sequence: number,
  ): Promise<void>;
  getCheckpoint(
    planId: string,
    stream: string,
  ): Promise<{ readonly cursor?: string; readonly sequence: number } | undefined>;
  setRouting(mode: AdoptionMode, planId: string): Promise<void>;
  getRouting(): Promise<{ readonly mode: AdoptionMode; readonly planId: string } | undefined>;
}

export interface HostIdentityBridge {
  resolveCustomer(external: Readonly<Record<string, unknown>>): Promise<CustomerId | undefined>;
}

export interface HostOrderBridge {
  findOrder(externalId: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  applyBillingEvent(event: CanonicalBillingEvent): Promise<void>;
}

export interface HostCatalogBridge {
  listCatalog(cursor?: string): Promise<MigrationPage>;
}
