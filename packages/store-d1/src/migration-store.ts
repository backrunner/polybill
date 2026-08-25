import type {
  AdoptionMode,
  MigrationItemClaim,
  MigrationItemResult,
  MigrationPlan,
  MigrationReport,
  MigrationStore,
} from "@polybill/migration";
import type { TenantId } from "@polybill/core";
import type { D1DatabaseLike, D1Result } from "./d1.js";
import { DefaultD1WriteCoordinator, type D1WriteCoordinator } from "./write-coordinator.js";

interface ItemStateRow {
  readonly state: "pending" | "processing" | "completed" | "failed";
}

export interface D1MigrationStoreOptions {
  readonly now?: () => number;
  readonly leaseToken?: () => string;
  readonly leaseMs?: number;
  readonly writes?: D1WriteCoordinator;
}

export class D1MigrationStore implements MigrationStore {
  readonly #db: D1DatabaseLike;
  readonly #tenantId: TenantId;
  readonly #now: () => number;
  readonly #leaseToken: () => string;
  readonly #leaseMs: number;
  readonly #writes: D1WriteCoordinator;

  constructor(db: D1DatabaseLike, tenantId: TenantId, options: D1MigrationStoreOptions = {}) {
    this.#db = db;
    this.#tenantId = tenantId;
    this.#now = options.now ?? Date.now;
    this.#leaseToken = options.leaseToken ?? (() => globalThis.crypto.randomUUID());
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#writes = options.writes ?? new DefaultD1WriteCoordinator(db);
  }

  async savePlan(plan: MigrationPlan): Promise<void> {
    if (plan.tenantId !== this.#tenantId)
      throw new Error("Migration plan tenant does not match store");
    await this.#writes.execute(
      [
        this.#db
          .prepare(
            `INSERT INTO polybill_migration_plans (tenant_id, plan_id, mode, state, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, plan_id) DO UPDATE SET mode = excluded.mode, state = excluded.state, value = excluded.value`,
          )
          .bind(this.#tenantId, plan.id, plan.mode, plan.phase, JSON.stringify(plan)),
        ...plan.items.map((item) =>
          this.#db
            .prepare(
              `INSERT INTO polybill_migration_items (tenant_id, plan_id, item_key, state, value) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT(tenant_id, plan_id, item_key) DO NOTHING`,
            )
            .bind(this.#tenantId, plan.id, item.key, JSON.stringify(item)),
        ),
      ],
      "migration.save_plan",
    );
  }

  async getPlan(planId: string): Promise<MigrationPlan | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_migration_plans WHERE tenant_id = ? AND plan_id = ?")
      .bind(this.#tenantId, planId)
      .first<{ value: string }>();
    return row === null ? undefined : parseJson<MigrationPlan>(row.value, "migration plan");
  }

  async claimItem(planId: string, itemKey: string): Promise<MigrationItemClaim> {
    const leaseToken = this.#leaseToken();
    const now = this.#now();
    const claimed = await this.#db
      .prepare(
        `UPDATE polybill_migration_items SET state = 'processing', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE tenant_id = ? AND plan_id = ? AND item_key = ? AND (state IN ('pending', 'failed') OR (state = 'processing' AND lease_expires_at <= ?))`,
      )
      .bind(leaseToken, now + this.#leaseMs, this.#tenantId, planId, itemKey, now)
      .run();
    if (changes(claimed) === 1) return { kind: "claimed", leaseToken };
    const row = await this.#db
      .prepare(
        "SELECT state FROM polybill_migration_items WHERE tenant_id = ? AND plan_id = ? AND item_key = ?",
      )
      .bind(this.#tenantId, planId, itemKey)
      .first<ItemStateRow>();
    if (row === null) throw new Error("Migration item does not exist in the saved plan");
    return row.state === "completed" ? { kind: "completed" } : { kind: "in_progress" };
  }

  async completeItem(
    planId: string,
    leaseToken: string,
    result: MigrationItemResult,
  ): Promise<void> {
    await this.#ownedUpdate(planId, result.itemKey, leaseToken, "completed", result);
  }

  async failItem(
    planId: string,
    itemKey: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<void> {
    await this.#ownedUpdate(planId, itemKey, leaseToken, "failed", {
      itemKey,
      status: "failed",
      errorCode,
    });
  }

  async listResults(planId: string): Promise<readonly MigrationItemResult[]> {
    const rows = await this.#db
      .prepare(
        "SELECT value FROM polybill_migration_items WHERE tenant_id = ? AND plan_id = ? AND state IN ('completed', 'failed') ORDER BY item_key",
      )
      .bind(this.#tenantId, planId)
      .all<{ value: string }>();
    return (rows.results ?? []).map((row) =>
      parseJson<MigrationItemResult>(row.value, "migration item result"),
    );
  }

  async saveReport(report: MigrationReport): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO polybill_migration_reports (tenant_id, plan_id, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, plan_id) DO UPDATE SET value = excluded.value`,
      )
      .bind(this.#tenantId, report.planId, JSON.stringify(report))
      .run();
  }

  async getReport(planId: string): Promise<MigrationReport | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_migration_reports WHERE tenant_id = ? AND plan_id = ?")
      .bind(this.#tenantId, planId)
      .first<{ value: string }>();
    return row === null ? undefined : parseJson<MigrationReport>(row.value, "migration report");
  }

  async saveCheckpoint(
    planId: string,
    stream: string,
    cursor: string | undefined,
    sequence: number,
  ): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO polybill_migration_checkpoints (tenant_id, plan_id, stream, cursor, sequence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, plan_id, stream) DO UPDATE SET cursor = excluded.cursor, sequence = excluded.sequence WHERE excluded.sequence >= polybill_migration_checkpoints.sequence`,
      )
      .bind(this.#tenantId, planId, stream, cursor ?? null, sequence)
      .run();
  }

  async getCheckpoint(planId: string, stream: string) {
    const row = await this.#db
      .prepare(
        "SELECT cursor, sequence FROM polybill_migration_checkpoints WHERE tenant_id = ? AND plan_id = ? AND stream = ?",
      )
      .bind(this.#tenantId, planId, stream)
      .first<{ cursor: string | null; sequence: number }>();
    if (row === null) return undefined;
    return { ...(row.cursor === null ? {} : { cursor: row.cursor }), sequence: row.sequence };
  }

  async setRouting(mode: AdoptionMode, planId: string): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO polybill_migration_routing (tenant_id, mode, plan_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET mode = excluded.mode, plan_id = excluded.plan_id, updated_at = excluded.updated_at`,
      )
      .bind(this.#tenantId, mode, planId, this.#now())
      .run();
  }

  async getRouting() {
    const row = await this.#db
      .prepare("SELECT mode, plan_id FROM polybill_migration_routing WHERE tenant_id = ?")
      .bind(this.#tenantId)
      .first<{ mode: AdoptionMode; plan_id: string }>();
    return row === null ? undefined : { mode: row.mode, planId: row.plan_id };
  }

  async #ownedUpdate(
    planId: string,
    itemKey: string,
    leaseToken: string,
    state: "completed" | "failed",
    value: MigrationItemResult,
  ): Promise<void> {
    const result = await this.#db
      .prepare(
        "UPDATE polybill_migration_items SET state = ?, value = ?, lease_token = NULL, lease_expires_at = NULL WHERE tenant_id = ? AND plan_id = ? AND item_key = ? AND state = 'processing' AND lease_token = ?",
      )
      .bind(state, JSON.stringify(value), this.#tenantId, planId, itemKey, leaseToken)
      .run();
    if (changes(result) !== 1) throw new Error("Migration item lease is not owned by this runner");
  }
}

function changes(result: D1Result): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new TypeError(`Stored ${label} is invalid JSON`);
  }
}
