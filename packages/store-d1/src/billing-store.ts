import {
  assertBillingWrite,
  assertCreditWrite,
  parseCreditEntry,
  type BillingRecord,
  type BillingScope,
  type BillingStore,
  type CreditEntry,
} from "@polybill/application";
import { parseIsoDateTime, type CustomerId, type IsoDateTime } from "@polybill/core";
import type { D1DatabaseLike } from "./d1.js";

const scopeSql = "tenant_id = ? AND connection_id = ? AND environment = ?";
interface RecordRow {
  kind: BillingRecord["kind"];
  id: string;
  version: number;
  due_at: string | null;
  value: string;
}

export class D1BillingStore implements BillingStore {
  constructor(readonly db: D1DatabaseLike) {}

  async getBillingRecord(scope: BillingScope, kind: BillingRecord["kind"], id: string) {
    const row = await this.db
      .prepare(`SELECT * FROM polybill_billing_records WHERE ${scopeSql} AND kind = ? AND id = ?`)
      .bind(...scopeValues(scope), kind, id)
      .first<RecordRow>();
    return row === null ? undefined : decode(row);
  }
  async putBillingRecord(scope: BillingScope, record: BillingRecord, expectedVersion: number) {
    assertBillingWrite(record, expectedVersion);
    const result =
      expectedVersion === 0
        ? await this.db
            .prepare(
              "INSERT INTO polybill_billing_records (tenant_id, connection_id, environment, kind, id, version, due_at, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            )
            .bind(
              ...scopeValues(scope),
              record.kind,
              record.id,
              record.version,
              record.dueAt ?? null,
              JSON.stringify(record.value),
            )
            .run()
        : await this.db
            .prepare(
              `UPDATE polybill_billing_records SET version = ?, due_at = ?, value = ? WHERE ${scopeSql} AND kind = ? AND id = ? AND version = ?`,
            )
            .bind(
              record.version,
              record.dueAt ?? null,
              JSON.stringify(record.value),
              ...scopeValues(scope),
              record.kind,
              record.id,
              expectedVersion,
            )
            .run();
    return result.meta?.changes === 1;
  }
  async listDueBillingRecords(
    scope: BillingScope,
    kind: BillingRecord["kind"],
    before: IsoDateTime,
    limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError("Invalid batch size");
    const rows = await this.db
      .prepare(
        `SELECT * FROM polybill_billing_records WHERE ${scopeSql} AND kind = ? AND due_at <= ? ORDER BY due_at, id LIMIT ?`,
      )
      .bind(...scopeValues(scope), kind, before, limit)
      .all<RecordRow>();
    return (rows.results ?? []).map(decode);
  }
  async getCreditEntry(scope: BillingScope, id: string): Promise<CreditEntry | undefined> {
    const row = await this.db
      .prepare(`SELECT value FROM polybill_credit_entries WHERE ${scopeSql} AND id = ?`)
      .bind(...scopeValues(scope), id)
      .first<{ value: string }>();
    return row === null ? undefined : parseCreditEntry(JSON.parse(row.value) as unknown);
  }
  async getCreditBalance(scope: BillingScope, customerId: CustomerId, unit: string) {
    return (
      (await this.db
        .prepare(
          `SELECT balance, revision FROM polybill_credit_entries WHERE ${scopeSql} AND customer_id = ? AND unit = ? ORDER BY revision DESC LIMIT 1`,
        )
        .bind(...scopeValues(scope), customerId, unit)
        .first<{ balance: string; revision: number }>()) ?? { balance: "0", revision: 0 }
    );
  }
  async appendCreditEntry(scope: BillingScope, entry: CreditEntry, expectedRevision: number) {
    assertCreditWrite(entry, expectedRevision);
    const current = await this.getCreditBalance(scope, entry.customerId, entry.unit);
    if (current.revision !== expectedRevision) return false;
    if (BigInt(current.balance) + BigInt(entry.delta) !== BigInt(entry.balance))
      throw new TypeError("Credit balance does not match entry delta");
    // One conditional INSERT is atomic even when the host persistence mode has no batch support.
    const result = await this.db
      .prepare(
        `INSERT INTO polybill_credit_entries (tenant_id, connection_id, environment, id, customer_id, unit, revision, balance, value) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(revision) FROM polybill_credit_entries WHERE ${scopeSql} AND customer_id = ? AND unit = ?), 0) = ? ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...scopeValues(scope),
        entry.id,
        entry.customerId,
        entry.unit,
        entry.revision,
        entry.balance,
        JSON.stringify(entry),
        ...scopeValues(scope),
        entry.customerId,
        entry.unit,
        expectedRevision,
      )
      .run();
    return result.meta?.changes === 1;
  }
}

function scopeValues(scope: BillingScope) {
  return [scope.tenantId, scope.connectionId, scope.environment] as const;
}
function decode(row: RecordRow): BillingRecord {
  return {
    kind: row.kind,
    id: row.id,
    version: row.version,
    ...(row.due_at === null ? {} : { dueAt: parseIsoDateTime(row.due_at) }),
    value: JSON.parse(row.value) as unknown,
  };
}
