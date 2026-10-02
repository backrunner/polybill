import {
  assertBillingWrite,
  assertCreditWrite,
  type BillingRecord,
  type BillingScope,
  type BillingStore,
  type CreditEntry,
} from "@polybill/application";
import type { CustomerId, IsoDateTime } from "@polybill/core";

export class MemoryBillingStore implements BillingStore {
  readonly #records = new Map<string, BillingRecord>();
  readonly #entries = new Map<string, CreditEntry>();
  readonly #balances = new Map<string, { balance: string; revision: number }>();

  async getBillingRecord(scope: BillingScope, kind: BillingRecord["kind"], id: string) {
    return globalThis.structuredClone(this.#records.get(key(scope, kind, id)));
  }
  async putBillingRecord(scope: BillingScope, record: BillingRecord, expectedVersion: number) {
    assertBillingWrite(record, expectedVersion);
    const id = key(scope, record.kind, record.id);
    if ((this.#records.get(id)?.version ?? 0) !== expectedVersion) return false;
    this.#records.set(id, globalThis.structuredClone(record));
    return true;
  }
  async listDueBillingRecords(
    scope: BillingScope,
    kind: BillingRecord["kind"],
    before: IsoDateTime,
    limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError("Invalid batch size");
    const prefix =
      JSON.stringify([scope.tenantId, scope.connectionId, scope.environment, kind]).slice(0, -1) +
      ",";
    return globalThis.structuredClone(
      [...this.#records.entries()]
        .filter(
          ([id, value]) =>
            id.startsWith(prefix) && value.dueAt !== undefined && value.dueAt <= before,
        )
        .map(([, value]) => value)
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.id.localeCompare(b.id))
        .slice(0, limit),
    );
  }
  async getCreditEntry(scope: BillingScope, id: string) {
    return globalThis.structuredClone(this.#entries.get(key(scope, "credit", id)));
  }
  async getCreditBalance(scope: BillingScope, customerId: CustomerId, unit: string) {
    return globalThis.structuredClone(
      this.#balances.get(key(scope, "balance", customerId, unit)) ?? { balance: "0", revision: 0 },
    );
  }
  async appendCreditEntry(scope: BillingScope, entry: CreditEntry, expectedRevision: number) {
    assertCreditWrite(entry, expectedRevision);
    const id = key(scope, "credit", entry.id);
    const account = key(scope, "balance", entry.customerId, entry.unit);
    const current = this.#balances.get(account) ?? { balance: "0", revision: 0 };
    if (this.#entries.has(id) || current.revision !== expectedRevision) return false;
    if (BigInt(current.balance) + BigInt(entry.delta) !== BigInt(entry.balance))
      throw new TypeError("Credit balance does not match entry delta");
    this.#entries.set(id, globalThis.structuredClone(entry));
    this.#balances.set(account, { balance: entry.balance, revision: entry.revision });
    return true;
  }
}

function key(scope: BillingScope, ...parts: readonly string[]) {
  return JSON.stringify([scope.tenantId, scope.connectionId, scope.environment, ...parts]);
}
