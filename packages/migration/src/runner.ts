import type { CapabilitySnapshot } from "@polybill/adapter-kit";
import { capabilitySnapshotHash } from "./planner.js";
import type { MigrationStore, MigrationTarget } from "./ports.js";
import type {
  MigrationItemResult,
  MigrationPlan,
  MigrationPlanItem,
  MigrationReport,
  MigrationVerification,
} from "./types.js";

export interface MigrationRunnerOptions {
  readonly store: MigrationStore;
  readonly target: MigrationTarget;
  /** Optional for offline runners; production apply/verify should inject it. */
  readonly capabilities?: () => Promise<MigrationExecutionCapabilities>;
  readonly stopAfterItems?: number;
}

export interface MigrationExecutionCapabilities {
  readonly source: CapabilitySnapshot;
  readonly target: CapabilitySnapshot;
}

export class MigrationCapabilityDriftError extends Error {
  readonly code = "migration_capability_drift";

  constructor() {
    super("Migration plan capabilities changed; create and approve a new plan");
    this.name = "MigrationCapabilityDriftError";
  }
}

export class MigrationRunner {
  readonly #options: MigrationRunnerOptions;

  constructor(options: MigrationRunnerOptions) {
    this.#options = options;
  }

  async dryRun(plan: MigrationPlan): Promise<MigrationReport> {
    const results: MigrationItemResult[] = [];
    for (const item of ordered(plan)) {
      const preview = await this.#options.target.preview(item);
      results.push({
        itemKey: item.key,
        status: item.action === "map_existing" ? "mapped" : "skipped",
        ...(preview.externalId === undefined ? {} : { externalId: preview.externalId }),
        evidence: { differences: preview.differences, action: item.action },
      });
    }
    const output = report(plan, "dry_run", results);
    await this.#options.store.saveReport(output);
    return output;
  }

  async apply(plan: MigrationPlan): Promise<MigrationReport> {
    if (plan.phase === "blocked" || plan.losses.some((loss) => loss.blocking)) {
      const output = report(plan, "blocked", await this.#options.store.listResults(plan.id));
      await this.#options.store.saveReport(output);
      return output;
    }
    await this.#assertPlanCapabilities(plan);
    await this.#options.store.savePlan({ ...plan, phase: "applying" });
    let completedThisRun = 0;
    for (const [sequence, item] of ordered(plan).entries()) {
      if (
        this.#options.stopAfterItems !== undefined &&
        completedThisRun >= this.#options.stopAfterItems
      )
        break;
      const claim = await this.#options.store.claimItem(plan.id, item.key);
      if (claim.kind !== "claimed") continue;
      try {
        const result = await this.#applyItem(plan, item);
        await this.#options.store.completeItem(plan.id, claim.leaseToken, result);
        await this.#options.store.saveCheckpoint(plan.id, "items", item.key, sequence + 1);
        completedThisRun += 1;
      } catch (error) {
        await this.#options.store.failItem(
          plan.id,
          item.key,
          claim.leaseToken,
          error instanceof Error ? error.name : "unknown_error",
        );
        const failedPlan = { ...plan, phase: "failed" as const };
        await this.#options.store.savePlan(failedPlan);
        await this.#options.store.saveReport(
          report(failedPlan, "failed", await this.#options.store.listResults(plan.id)),
        );
        throw error;
      }
    }
    const results = await this.#options.store.listResults(plan.id);
    const phase: MigrationPlan["phase"] =
      results.length === plan.items.length ? "verifying" : "applying";
    const nextPlan = { ...plan, phase };
    await this.#options.store.savePlan(nextPlan);
    const output = report(nextPlan, phase, results);
    await this.#options.store.saveReport(output);
    return output;
  }

  async verify(plan: MigrationPlan): Promise<readonly MigrationVerification[]> {
    await this.#assertPlanCapabilities(plan);
    await this.#options.store.savePlan({ ...plan, phase: "verifying" });
    const results = await this.#options.store.listResults(plan.id);
    const byKey = new Map(results.map((result) => [result.itemKey, result]));
    const verifications = await Promise.all(
      ordered(plan).map((item) => {
        if (
          item.action === "keep_source_pinned" ||
          item.action === "request_reauthorization" ||
          item.action === "provider_assisted" ||
          item.action === "manual_review"
        )
          return Promise.resolve({
            itemKey: item.key,
            status: "manual" as const,
            differences: item.losses.map((loss) => loss.code),
          });
        return this.#options.target.verify(item, byKey.get(item.key)?.externalId);
      }),
    );
    // Manual reauthorization/provider-assisted work is an approved migration outcome;
    // only unresolved target differences or missing objects block cutover.
    const ready =
      verifications.every(
        (verification) => verification.status === "matched" || verification.status === "manual",
      ) && !plan.losses.some((loss) => loss.blocking);
    const phase: MigrationPlan["phase"] = ready ? "ready" : "verifying";
    const nextPlan = { ...plan, phase };
    await this.#options.store.savePlan(nextPlan);
    await this.#options.store.saveReport(report(nextPlan, nextPlan.phase, results, verifications));
    return verifications;
  }

  async cutover(plan: MigrationPlan): Promise<void> {
    await this.#assertPlanCapabilities(plan);
    const saved = await this.#options.store.getPlan(plan.id);
    if (saved?.phase !== "ready")
      throw new Error("Migration plan must pass verification before cutover");
    await this.#options.store.setRouting(plan.mode, plan.id);
  }

  async cutback(plan: MigrationPlan, mode: "observe_only" | "shadow_read"): Promise<void> {
    await this.#options.store.setRouting(mode, plan.id);
    await this.#options.store.savePlan({ ...plan, phase: "cutback" });
    await this.#options.store.saveReport(
      report(
        { ...plan, phase: "cutback" },
        "cutback",
        await this.#options.store.listResults(plan.id),
      ),
    );
  }

  async #assertPlanCapabilities(plan: MigrationPlan): Promise<void> {
    if (this.#options.capabilities === undefined) return;
    const capabilities = await this.#options.capabilities();
    const [sourceHash, targetHash] = await Promise.all([
      capabilitySnapshotHash(capabilities.source),
      capabilitySnapshotHash(capabilities.target),
    ]);
    if (sourceHash !== plan.sourceCapabilitiesHash || targetHash !== plan.targetCapabilitiesHash)
      throw new MigrationCapabilityDriftError();
  }

  async #applyItem(plan: MigrationPlan, item: MigrationPlanItem): Promise<MigrationItemResult> {
    const idempotencyKey = `migration:${plan.id}:${item.key}`;
    if (
      item.action === "keep_source_pinned" ||
      item.action === "request_reauthorization" ||
      item.action === "provider_assisted" ||
      item.action === "manual_review"
    )
      return { itemKey: item.key, status: "skipped" };
    if (item.action === "map_existing")
      return {
        itemKey: item.key,
        status: "mapped",
        ...(item.targetExternalId === undefined ? {} : { externalId: item.targetExternalId }),
      };
    const operation =
      item.action === "create_target"
        ? "create"
        : item.action === "update_target"
          ? "update"
          : "archive";
    const result = await this.#options.target[operation](item, idempotencyKey);
    return {
      itemKey: item.key,
      status: operation === "create" ? "created" : operation === "update" ? "updated" : "archived",
      externalId: result.externalId,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    };
  }
}

function ordered(plan: MigrationPlan): readonly MigrationPlanItem[] {
  const completed = new Set<string>();
  const pending = [...plan.items];
  const output: MigrationPlanItem[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((item) => item.dependsOn.every((key) => completed.has(key)));
    if (index < 0) throw new TypeError("Migration plan contains a dependency cycle or missing key");
    const [item] = pending.splice(index, 1);
    if (item === undefined) throw new TypeError("Migration item ordering failed");
    output.push(item);
    completed.add(item.key);
  }
  return output;
}

function report(
  plan: MigrationPlan,
  phase: MigrationReport["phase"],
  results: readonly MigrationItemResult[],
  verifications: readonly MigrationVerification[] = [],
): MigrationReport {
  const totals: Record<MigrationItemResult["status"], number> = {
    skipped: 0,
    mapped: 0,
    created: 0,
    updated: 0,
    archived: 0,
    failed: 0,
  };
  for (const result of results) totals[result.status] += 1;
  return {
    planId: plan.id,
    phase,
    total: plan.items.length,
    scanned: results.length,
    manual: verifications.filter((verification) => verification.status === "manual").length,
    totals,
    results,
    verifications,
    losses: plan.losses,
    blockers: plan.losses.filter((loss) => loss.blocking),
  };
}
