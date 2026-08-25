import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "./d1.js";

/** Execution strategy for a group of idempotent D1 writes. */
export type D1WriteMode = "batch" | "sequential";

export interface D1WriteCoordinatorOptions {
  /** Defaults to `batch`, matching Cloudflare D1 batch semantics. */
  readonly mode?: D1WriteMode;
}

export interface D1WriteCoordinator {
  readonly mode: D1WriteMode;
  execute(
    statements: readonly D1PreparedStatement[],
    operation?: string,
  ): Promise<readonly D1Result[]>;
}

/**
 * Anti-corruption boundary around D1 writes. D1 deployments that do not offer
 * transactional batches can opt into sequential execution; statements must
 * then be idempotent and callers can safely retry the operation after a
 * partial failure. The coordinator preserves statement order and reports the
 * completed count for observability/recovery.
 */
export class DefaultD1WriteCoordinator implements D1WriteCoordinator {
  readonly #db: D1DatabaseLike;
  readonly mode: D1WriteMode;

  constructor(db: D1DatabaseLike, options: D1WriteCoordinatorOptions = {}) {
    this.#db = db;
    this.mode = options.mode ?? "batch";
  }

  async execute(
    statements: readonly D1PreparedStatement[],
    operation = "d1.write",
  ): Promise<readonly D1Result[]> {
    if (this.mode === "batch") return this.#db.batch(statements);
    const results: D1Result[] = [];
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      if (statement === undefined) throw new Error("D1 write statement disappeared");
      try {
        results.push(await statement.run());
      } catch (cause) {
        throw new D1WriteCoordinatorError(operation, index, results, cause);
      }
    }
    return results;
  }
}

export class D1WriteCoordinatorError extends Error {
  readonly code = "d1_write_partial_failure" as const;
  readonly operation: string;
  readonly completed: number;
  readonly results: readonly D1Result[];
  override readonly cause: unknown;

  constructor(operation: string, completed: number, results: readonly D1Result[], cause: unknown) {
    super(`D1 write operation ${operation} failed after ${completed} statement(s)`);
    this.name = "D1WriteCoordinatorError";
    this.operation = operation;
    this.completed = completed;
    this.results = results;
    this.cause = cause;
  }
}
