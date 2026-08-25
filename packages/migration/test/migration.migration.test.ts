import { nativeCapability, type CapabilitySnapshot } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import {
  MemoryMigrationStore,
  MigrationCapabilityDriftError,
  MigrationRunner,
  analyzeSource,
  importSourceItems,
  parseMigrationCli,
  planMigration,
  providerRecordImportCodec,
  runMigrationCli,
  type MigrationPlan,
  type MigrationPlanItem,
  type MigrationTarget,
} from "../src/index.js";

const now = parseIsoDateTime("2026-08-25T00:00:00.000Z");
const tenantId = parseId<"TenantId">("ten_migration", "ten");
const sourceConnectionId = parseId<"ConnectionId">("conn_source", "conn");
const targetConnectionId = parseId<"ConnectionId">("conn_target", "conn");

describe("migration toolkit", () => {
  it("dry-runs with target reads and no external mutation", async () => {
    const target = fakeTarget();
    const plan = await productPlan();
    const report = await new MigrationRunner({ store: new MemoryMigrationStore(), target }).dryRun(
      plan,
    );

    expect(report.phase).toBe("dry_run");
    expect(report).toMatchObject({ total: 2, scanned: 2, manual: 0, losses: [] });
    expect(target.previewCount).toBe(2);
    expect(target.writeCount).toBe(0);
  });

  it("resumes and repeats apply without duplicating target creates", async () => {
    const store = new MemoryMigrationStore();
    const target = fakeTarget();
    const plan = await productPlan();

    await new MigrationRunner({ store, target, stopAfterItems: 1 }).apply(plan);
    expect(target.writeCount).toBe(1);
    const resumed = await new MigrationRunner({ store, target }).apply(plan);
    expect(resumed.totals.created).toBe(2);
    expect(target.writeCount).toBe(2);
    await new MigrationRunner({ store, target }).apply(plan);
    expect(target.writeCount).toBe(2);
  });

  it("persists reports and blocks writes when capabilities drift", async () => {
    const store = new MemoryMigrationStore();
    const target = fakeTarget();
    const plan = await productPlan();
    const dryRun = await new MigrationRunner({ store, target }).dryRun(plan);
    await expect(store.getReport(plan.id)).resolves.toEqual(dryRun);
    await expect(
      new MigrationRunner({
        store,
        target,
        capabilities: async () => ({
          source: snapshot("provider"),
          target: snapshot("merchant"),
        }),
      }).apply(plan),
    ).rejects.toBeInstanceOf(MigrationCapabilityDriftError);
    expect(target.writeCount).toBe(0);
  });

  it("recovers an abandoned item only after its lease expires", async () => {
    let time = 100;
    let token = 0;
    const store = new MemoryMigrationStore({
      now: () => time,
      leaseMs: 10,
      leaseToken: () => `lease-${++token}`,
    });
    const plan = await productPlan();
    await store.savePlan(plan);
    await expect(store.claimItem(plan.id, "product")).resolves.toEqual({
      kind: "claimed",
      leaseToken: "lease-1",
    });
    await expect(store.claimItem(plan.id, "product")).resolves.toEqual({ kind: "in_progress" });
    time = 111;
    await expect(store.claimItem(plan.id, "product")).resolves.toEqual({
      kind: "claimed",
      leaseToken: "lease-2",
    });
  });

  it("keeps active subscriptions pinned and never copies payment credentials", async () => {
    const plan = await planMigration({
      ...basePlanInput("dual_run"),
      items: [
        {
          key: "subscription",
          entityType: "subscription",
          sourceId: "sub_source",
          payload: {},
          active: true,
        },
        {
          key: "wallet",
          entityType: "payment_method",
          sourceId: "pm_wallet",
          payload: { token: "must-not-copy" },
          paymentMethodKind: "wallet",
        },
      ],
    });

    expect(plan.items.map((item) => item.action)).toEqual([
      "keep_source_pinned",
      "request_reauthorization",
    ]);
    expect(JSON.stringify(plan)).not.toContain("must-not-copy");
  });

  it("blocks legal responsibility changes until acknowledged", async () => {
    const blocked = await planMigration({
      ...basePlanInput("new_sales_cutover"),
      targetCapabilities: snapshot("merchant"),
      items: [],
    });
    expect(blocked.phase).toBe("blocked");
    expect(blocked.losses).toContainEqual(
      expect.objectContaining({ code: "legal_responsibility_change", blocking: true }),
    );

    const approved = await planMigration({
      ...basePlanInput("new_sales_cutover"),
      targetCapabilities: snapshot("merchant"),
      legalResponsibilityAcknowledged: true,
      items: [],
    });
    expect(approved.phase).toBe("planned");
  });

  it("verifies automated items, reports workflows as manual, and supports cutback", async () => {
    const store = new MemoryMigrationStore();
    const target = fakeTarget();
    const plan = await planMigration({
      ...basePlanInput("full_control"),
      items: [
        { key: "product", entityType: "product", sourceId: "prod_1", payload: {} },
        {
          key: "card",
          entityType: "payment_method",
          sourceId: "pm_1",
          payload: {},
          paymentMethodKind: "card",
        },
      ],
    });
    await new MigrationRunner({ store, target }).apply(plan);
    const verification = await new MigrationRunner({ store, target }).verify(plan);
    expect(verification).toEqual([
      { itemKey: "card", status: "manual", differences: ["reauthorization_required"] },
      { itemKey: "product", status: "matched", differences: [] },
    ]);

    const runner = new MigrationRunner({ store, target });
    await runner.cutover(plan);
    await expect(store.getRouting()).resolves.toEqual({ mode: "full_control", planId: plan.id });
    await runner.cutback(plan, "shadow_read");
    await expect(store.getRouting()).resolves.toEqual({ mode: "shadow_read", planId: plan.id });
  });

  it("analyzes paginated sources while recursively redacting PII and secrets", async () => {
    const cursors: (string | undefined)[] = [];
    const result = await analyzeSource(
      {
        async scan(_type, cursor) {
          cursors.push(cursor);
          return cursor === undefined
            ? {
                items: [
                  {
                    id: "cust_1",
                    profile: { email: "buyer@example.com", nested: [{ apiKey: "secret" }] },
                  },
                ],
                nextCursor: "page-2",
              }
            : { items: [{ id: "cust_2", customerName: "Buyer" }] };
        },
      },
      ["customer"],
    );

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(result.counts.customer).toBe(2);
    expect(result.samples.customer).toEqual([
      { id: "cust_1", profile: { email: "[REDACTED]", nested: [{ apiKey: "[REDACTED]" }] } },
      { id: "cust_2", customerName: "[REDACTED]" },
    ]);
  });

  it("imports paginated provider snapshots with checkpoints and rejects cursor cycles", async () => {
    const checkpoints: unknown[] = [];
    const imported = await importSourceItems({
      scanner: {
        scan: async (_type, cursor) =>
          cursor === undefined
            ? { items: [{ id: "prod_1" }], nextCursor: "page-2" }
            : { items: [{ id: "prod_2" }] },
      },
      codec: providerRecordImportCodec,
      entityTypes: ["product"],
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });
    expect(imported.map((item) => item.key)).toEqual(["product:prod_1", "product:prod_2"]);
    expect(checkpoints).toEqual([
      { entityType: "product", cursor: "page-2", sequence: 1 },
      { entityType: "product", sequence: 2 },
    ]);
    await expect(
      importSourceItems({
        scanner: { scan: async () => ({ items: [], nextCursor: "same" }) },
        codec: {
          decode: () => ({ key: "unused", entityType: "product", sourceId: "unused", payload: {} }),
        },
        entityTypes: ["product"],
      }),
    ).rejects.toThrow(/cursor cycle/);
  });

  it("parses the migration CLI and requires confirmation for routing or writes", async () => {
    expect(parseMigrationCli(["dry-run", "--plan", "migration-001", "--format", "json"])).toEqual({
      action: "dry-run",
      planId: "migration-001",
      format: "json",
      confirmed: false,
    });
    const output: string[] = [];
    const backend = { execute: async () => ({ status: "applied" }) };
    await expect(
      runMigrationCli(["apply", "--plan", "migration-001"], backend, {
        write: (value) => output.push(value),
      }),
    ).resolves.toBe(1);
    expect(output[0]).toContain("requires --yes");
    await expect(
      runMigrationCli(
        ["cutback", "--plan", "migration-001", "--mode", "shadow_read", "--yes"],
        backend,
        {
          write: (value) => output.push(value),
        },
      ),
    ).resolves.toBe(0);
  });
});

async function productPlan(): Promise<MigrationPlan> {
  return planMigration({
    ...basePlanInput("new_sales_cutover"),
    items: [
      { key: "product", entityType: "product", sourceId: "prod_source", payload: { name: "Pro" } },
      {
        key: "price",
        entityType: "price",
        sourceId: "price_source",
        payload: { amount: "2500", currency: "USD" },
        dependsOn: ["product"],
      },
    ],
  });
}

function basePlanInput(mode: MigrationPlan["mode"]) {
  return {
    id: "migration-contract",
    tenantId,
    sourceConnectionId,
    targetConnectionId,
    mode,
    sourceCapabilities: snapshot("provider"),
    targetCapabilities: snapshot("provider"),
    createdAt: now,
  } as const;
}

function snapshot(seller: "provider" | "merchant"): CapabilitySnapshot {
  return {
    provider: "stripe",
    adapterVersion: "0.1.0",
    providerApiVersion: "fixture-v1",
    capabilities: {
      "migration.catalog": nativeCapability("recreate"),
      "migration.customer": nativeCapability("recreate"),
      "migration.subscription": nativeCapability("reauthorize"),
    },
    commercialTerms: {
      model: seller === "provider" ? "merchant_of_record" : "payment_processor",
      sellerOfRecord: seller,
      taxCalculation: seller,
      taxInvoiceIssuer: seller,
      disputeResponsibility: seller,
      observedAt: now,
      evidenceRef: parseId<"EvidenceId">(`evi_${seller}`, "evi"),
    },
    observedAt: now,
  };
}

function fakeTarget(): MigrationTarget & {
  readonly previewCount: number;
  readonly writeCount: number;
} {
  let previewCount = 0;
  let writeCount = 0;
  const mutate = async (item: MigrationPlanItem) => {
    writeCount += 1;
    return { externalId: `target_${item.key}` };
  };
  return {
    get previewCount() {
      return previewCount;
    },
    get writeCount() {
      return writeCount;
    },
    async preview(item) {
      previewCount += 1;
      return { externalId: `preview_${item.key}`, differences: [] };
    },
    create: mutate,
    update: mutate,
    archive: mutate,
    async verify(item) {
      return { itemKey: item.key, status: "matched", differences: [] };
    },
  };
}
