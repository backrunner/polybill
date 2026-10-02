import { readFile } from "node:fs/promises";
import type { BillingScope, CreditEntry } from "@polybill/application";
import { parseId, parseIsoDateTime } from "@polybill/core";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1BillingStore } from "../src/index.js";

const scope: BillingScope = {
  tenantId: parseId<"TenantId">("ten_billingtest", "ten"),
  connectionId: parseId<"ConnectionId">("conn_billingtest", "conn"),
  environment: "test",
};
const now = parseIsoDateTime("2026-10-02T00:00:00.000Z");
const customerId = parseId<"CustomerId">("cust_billingtest", "cust");
const entry: CreditEntry = {
  id: "credit_initial",
  customerId,
  unit: "tokens",
  revision: 1,
  delta: "9007199254740993",
  balance: "9007199254740993",
  payloadHash: "hash",
  occurredAt: now,
};

describe("D1 durable billing store", () => {
  let mf: Miniflare;
  let store: D1BillingStore;
  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: { DB: "billing" },
    });
    const db = await mf.getD1Database("DB");
    const sql = await readFile(
      new URL("../migrations/0012_billing_workflows.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql.replaceAll(/\s+/g, " "));
    await db.exec(sql.replaceAll(/\s+/g, " "));
    store = new D1BillingStore(db);
  });
  afterEach(async () => {
    await mf.dispose();
  });

  it("claims a workflow once, applies CAS, and isolates environments", async () => {
    const record = {
      kind: "schedule",
      id: "test",
      version: 1,
      dueAt: now,
      value: { phase: "pending" },
    } as const;
    const results = await Promise.all([
      store.putBillingRecord(scope, record, 0),
      store.putBillingRecord(scope, record, 0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listDueBillingRecords(scope, "schedule", now, 10)).toHaveLength(1);
    expect(
      await store.getBillingRecord({ ...scope, environment: "live" }, "schedule", "test"),
    ).toBeUndefined();
    expect(
      await store.putBillingRecord(
        scope,
        { ...record, version: 2, value: { phase: "complete" } },
        1,
      ),
    ).toBe(true);
    expect(await store.putBillingRecord(scope, { ...record, version: 2 }, 1)).toBe(false);
  });
  it("atomically appends exactly one concurrent debit without numeric coercion", async () => {
    expect(await store.appendCreditEntry(scope, entry, 0)).toBe(true);
    const debit = { ...entry, delta: "-9007199254740992", balance: "1", revision: 2 };
    const results = await Promise.all([
      store.appendCreditEntry(scope, { ...debit, id: "debit_a" }, 1),
      store.appendCreditEntry(scope, { ...debit, id: "debit_b" }, 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.getCreditBalance(scope, customerId, "tokens")).toEqual({
      balance: "1",
      revision: 2,
    });
    expect(await store.appendCreditEntry(scope, entry, 0)).toBe(false);
    expect(await store.getCreditEntry(scope, entry.id)).toEqual(entry);
    expect(
      await store.getCreditBalance({ ...scope, environment: "live" }, customerId, "tokens"),
    ).toEqual({ balance: "0", revision: 0 });
  });
  it("rejects a forged balance or overdraft before appending", async () => {
    await expect(store.appendCreditEntry(scope, { ...entry, balance: "1" }, 0)).rejects.toThrow();
    await expect(
      store.appendCreditEntry(scope, { ...entry, delta: "-1", balance: "-1" }, 0),
    ).rejects.toThrow();
    expect(await store.getCreditEntry(scope, entry.id)).toBeUndefined();
  });
});
