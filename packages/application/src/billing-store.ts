import type { ConnectionId, CustomerId, Environment, IsoDateTime, TenantId } from "@polybill/core";
import { parseId, parseIsoDateTime } from "@polybill/core";

export interface BillingScope {
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly environment: Environment;
}
export interface BillingRecord {
  readonly kind: "schedule" | "schedule_owner" | "meter" | "usage" | "authorization";
  readonly id: string;
  readonly version: number;
  readonly dueAt?: IsoDateTime;
  readonly value: unknown;
}
export interface CreditEntry {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly unit: string;
  readonly delta: string;
  readonly balance: string;
  readonly revision: number;
  readonly payloadHash: string;
  readonly occurredAt: IsoDateTime;
}

/** Writes are atomic CAS operations; a false result means that no state was changed. */
export interface BillingStore {
  getBillingRecord(
    scope: BillingScope,
    kind: BillingRecord["kind"],
    id: string,
  ): Promise<BillingRecord | undefined>;
  putBillingRecord(
    scope: BillingScope,
    record: BillingRecord,
    expectedVersion: number,
  ): Promise<boolean>;
  listDueBillingRecords(
    scope: BillingScope,
    kind: BillingRecord["kind"],
    before: IsoDateTime,
    limit: number,
  ): Promise<readonly BillingRecord[]>;
  getCreditEntry(scope: BillingScope, id: string): Promise<CreditEntry | undefined>;
  getCreditBalance(
    scope: BillingScope,
    customerId: CustomerId,
    unit: string,
  ): Promise<{ readonly balance: string; readonly revision: number }>;
  appendCreditEntry(
    scope: BillingScope,
    entry: CreditEntry,
    expectedRevision: number,
  ): Promise<boolean>;
}

export function assertBillingWrite(record: BillingRecord, expectedVersion: number): void {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    !Number.isSafeInteger(record.version) ||
    record.version !== expectedVersion + 1 ||
    record.id.length < 1 ||
    record.id.length > 255
  )
    throw new TypeError("Invalid billing record version or ID");
}
export function assertCreditWrite(entry: CreditEntry, expectedRevision: number): void {
  parseCreditEntry(entry);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision !== expectedRevision + 1 ||
    !/^-?[1-9][0-9]{0,77}$/.test(entry.delta) ||
    !/^(0|[1-9][0-9]*)$/.test(entry.balance)
  )
    throw new TypeError("Invalid credit entry");
}

export function parseCreditEntry(value: unknown): CreditEntry {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid credit entry");
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    entry.id.length < 1 ||
    entry.id.length > 255 ||
    typeof entry.unit !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(entry.unit) ||
    typeof entry.delta !== "string" ||
    !/^-?[1-9][0-9]{0,77}$/.test(entry.delta) ||
    typeof entry.balance !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(entry.balance) ||
    typeof entry.revision !== "number" ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 1 ||
    typeof entry.payloadHash !== "string" ||
    entry.payloadHash.length === 0
  )
    throw new TypeError("Invalid credit entry");
  return {
    id: entry.id,
    customerId: parseId<"CustomerId">(entry.customerId, "cust"),
    unit: entry.unit,
    delta: entry.delta,
    balance: entry.balance,
    revision: entry.revision,
    payloadHash: entry.payloadHash,
    occurredAt: parseIsoDateTime(entry.occurredAt),
  };
}
