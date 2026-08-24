import { PolybillError, parseId, parseIdempotencyKey, type IdempotencyKey } from "@polybill/core";
import { stableStringify } from "./checkout-helpers.js";
import { CustomerService } from "./customers.js";
import { RefundService } from "./refunds.js";
import type { ReconciliationTarget } from "./ports.js";
import type { ResourceRuntime } from "./resource-runtime.js";
import { SubscriptionService } from "./subscriptions.js";

export type ReconciliationMode = "report_only" | "projection_only";

export interface ReconciliationDifference {
  readonly field: string;
  readonly local: unknown;
  readonly remote: unknown;
}

export interface ReconciliationItemReport extends ReconciliationTarget {
  readonly status: "matched" | "different" | "applied" | "unsupported" | "failed";
  readonly differences: readonly ReconciliationDifference[];
  readonly errorCode?: string;
}

export interface ReconciliationBatchReport {
  readonly stream: string;
  readonly sequence: number;
  readonly cursor?: string;
  readonly items: readonly ReconciliationItemReport[];
}

export class ReconciliationService {
  readonly #runtime: ResourceRuntime;

  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async inspect(target: ReconciliationTarget): Promise<ReconciliationItemReport> {
    try {
      const differences = await this.#differences(target);
      return {
        ...target,
        status: differences.length === 0 ? "matched" : "different",
        differences,
      };
    } catch (error) {
      return {
        ...target,
        status:
          error instanceof PolybillError && error.code === "unsupported_capability"
            ? "unsupported"
            : "failed",
        differences: [],
        errorCode:
          error instanceof PolybillError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown_error",
      };
    }
  }

  async run(input: {
    readonly stream: string;
    readonly mode: ReconciliationMode;
    readonly limit?: number;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<ReconciliationBatchReport> {
    const scope = {
      tenantId: this.#runtime.options.tenantId,
      connectionId: this.#runtime.options.connection.id,
      stream: input.stream,
    } as const;
    const checkpoint = await this.#runtime.options.store.getReconciliationCheckpoint(scope);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new RangeError("Reconciliation limit must be between 1 and 1000");
    const page = await this.#runtime.options.store.listReconciliationTargets({
      tenantId: scope.tenantId,
      connectionId: scope.connectionId,
      ...(checkpoint?.cursor === undefined ? {} : { after: checkpoint.cursor }),
      limit,
    });
    const reports: ReconciliationItemReport[] = [];
    for (const [index, target] of page.items.entries()) {
      const report = await this.inspect(target);
      if (input.mode === "projection_only" && report.status === "different") {
        try {
          await this.#apply(
            target,
            parseIdempotencyKey(`${input.idempotencyKey}:${checkpoint?.sequence ?? 0}:${index}`),
          );
          reports.push({ ...report, status: "applied" });
        } catch (error) {
          reports.push({
            ...report,
            status: "failed",
            errorCode:
              error instanceof PolybillError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "unknown_error",
          });
        }
      } else reports.push(report);
    }
    const sequence = (checkpoint?.sequence ?? 0) + page.items.length;
    const cursor = page.nextCursor ?? checkpoint?.cursor;
    await this.#runtime.options.store.saveReconciliationCheckpoint({
      ...scope,
      ...(cursor === undefined ? {} : { cursor }),
      sequence,
      observedAt: this.#runtime.options.clock.now(),
    });
    return {
      stream: input.stream,
      sequence,
      ...(cursor === undefined ? {} : { cursor }),
      items: reports,
    };
  }

  async #differences(target: ReconciliationTarget): Promise<readonly ReconciliationDifference[]> {
    const current = await this.#runtime.options.store.getResource<Record<string, unknown>>(
      this.#runtime.options.tenantId,
      target.entityType,
      target.entityId,
    );
    if (current === undefined) return [{ field: "$", local: undefined, remote: "present" }];
    const context = await this.#runtime.context();
    if (target.entityType === "customer") {
      await this.#runtime.requireCapability("customer.read", context);
      const get = this.#runtime.options.adapter.customers?.get;
      if (get === undefined) throw unsupported("customer.read");
      const remote = (await get(context, target.externalId)).value;
      return compare(current, {
        email: remote.email,
        name: remote.name,
        status: remote.status,
      });
    }
    if (target.entityType === "subscription") {
      await this.#runtime.requireCapability("subscription.read", context);
      const get = this.#runtime.options.adapter.subscriptions?.get;
      if (get === undefined) throw unsupported("subscription.read");
      const remote = (await get(context, target.externalId)).value;
      const items = await Promise.all(
        remote.items.map(async (item) => ({
          priceId:
            (await this.#runtime.options.store.findCanonicalId(
              this.#runtime.options.tenantId,
              this.#runtime.options.connection.id,
              "price",
              item.externalPriceId,
            )) ?? item.externalPriceId,
          quantity: item.quantity,
        })),
      );
      return compare(current, {
        status: remote.status,
        items,
        currentPeriodStart: remote.currentPeriodStart,
        currentPeriodEnd: remote.currentPeriodEnd,
      });
    }
    const get = this.#runtime.options.adapter.refunds?.get;
    if (get === undefined) throw unsupported("refund.read");
    const remote = (await get(context, target.externalId)).value;
    return compare(current, { amount: remote.amount, status: remote.status });
  }

  async #apply(target: ReconciliationTarget, key: IdempotencyKey): Promise<void> {
    if (target.entityType === "customer") {
      await new CustomerService(this.#runtime).refresh(
        parseId<"CustomerId">(target.entityId, "cust"),
        key,
      );
      return;
    }
    if (target.entityType === "subscription") {
      await new SubscriptionService(this.#runtime).refresh(
        parseId<"SubscriptionId">(target.entityId, "sub"),
        key,
      );
      return;
    }
    await new RefundService(this.#runtime).refresh(
      parseId<"RefundId">(target.entityId, "ref"),
      key,
    );
  }
}

function compare(
  local: Readonly<Record<string, unknown>>,
  remote: Readonly<Record<string, unknown>>,
): readonly ReconciliationDifference[] {
  return Object.entries(remote).flatMap(([field, value]) =>
    value !== undefined && stableStringify(local[field]) !== stableStringify(value)
      ? [{ field, local: local[field], remote: value }]
      : [],
  );
}

function unsupported(operation: string): PolybillError {
  return new PolybillError("Provider reconciliation read is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}
