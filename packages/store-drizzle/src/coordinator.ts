import type { SQL } from "drizzle-orm";

/** A dialect-neutral Drizzle SQL expression type for adapter integrations. */
export type DrizzleSql = SQL;

export type DrizzleWriteMode = "transaction" | "sequential";

export interface DrizzleDatabaseLike<TSession extends object = object> {
  /** Drizzle dialects expose this for transactional sessions; D1 deployments may omit it. */
  readonly transaction?: <T>(work: (session: TSession) => T | Promise<T>) => T | Promise<T>;
}

export type DrizzleWriteStep<TSession extends object, TResult = unknown> = (
  session: TSession,
) => TResult | Promise<TResult>;

export interface DrizzleWriteCoordinatorOptions {
  /** Defaults to transaction when the supplied Drizzle database exposes transaction(). */
  readonly mode?: DrizzleWriteMode;
  /** Permit a sequential replay-safe fallback when transaction() is unavailable. */
  readonly fallbackToSequential?: boolean;
}

export interface DrizzleWriteCoordinator<TSession extends object = object> {
  readonly mode: DrizzleWriteMode;
  execute<TResult>(
    steps: readonly DrizzleWriteStep<TSession, TResult>[],
    operation?: string,
  ): Promise<readonly TResult[]>;
}

export class DrizzleWriteCoordinatorError extends Error {
  readonly code = "persistence_write_partial_failure" as const;
  readonly operation: string;
  readonly completed: number;
  readonly mode: DrizzleWriteMode;
  readonly results: readonly unknown[];
  override readonly cause: unknown;

  constructor(
    operation: string,
    completed: number,
    mode: DrizzleWriteMode,
    results: readonly unknown[],
    cause: unknown,
  ) {
    super(`Persistence operation ${operation} failed after ${completed} step(s)`);
    this.name = "DrizzleWriteCoordinatorError";
    this.operation = operation;
    this.completed = completed;
    this.mode = mode;
    this.results = results;
    this.cause = cause;
  }
}

export class DrizzleTransactionUnavailableError extends Error {
  readonly code = "persistence_transaction_unavailable" as const;
  readonly operation: string;

  constructor(operation: string) {
    super(`Drizzle database does not expose a transaction for ${operation}`);
    this.name = "DrizzleTransactionUnavailableError";
    this.operation = operation;
  }
}

export class DefaultDrizzleWriteCoordinator<
  TDatabase extends object,
  TSession extends object = TDatabase,
> implements DrizzleWriteCoordinator<TSession> {
  readonly #database: TDatabase;
  readonly #fallbackToSequential: boolean;
  readonly mode: DrizzleWriteMode;

  constructor(database: TDatabase, options: DrizzleWriteCoordinatorOptions = {}) {
    this.#database = database;
    this.#fallbackToSequential = options.fallbackToSequential ?? false;
    const hasTransaction = typeof Reflect.get(database, "transaction") === "function";
    const requestedMode = options.mode ?? (hasTransaction ? "transaction" : "sequential");
    this.mode =
      requestedMode === "transaction" && !hasTransaction && options.fallbackToSequential === true
        ? "sequential"
        : requestedMode === "transaction" && !hasTransaction
          ? "transaction"
          : requestedMode;
  }

  async execute<TResult>(
    steps: readonly DrizzleWriteStep<TSession, TResult>[],
    operation = "persistence.write",
  ): Promise<readonly TResult[]> {
    if (steps.length === 0) return [];
    if (this.mode === "transaction") {
      const database = this.#database;
      const transaction = Reflect.get(database, "transaction");
      if (typeof transaction !== "function") {
        if (!this.#fallbackToSequential) throw new DrizzleTransactionUnavailableError(operation);
      } else {
        try {
          // Drizzle database methods use `this` to access the underlying session.
          const runner = transaction as <T>(
            work: (session: TSession) => T | Promise<T>,
          ) => T | Promise<T>;
          return await Reflect.apply(runner, database, [
            async (session: TSession) => {
              const results: TResult[] = [];
              for (const step of steps) results.push(await step(session));
              return results;
            },
          ]);
        } catch (cause) {
          throw new DrizzleWriteCoordinatorError(operation, 0, "transaction", [], cause);
        }
      }
    }
    return this.#executeSequential(steps, operation);
  }

  async #executeSequential<TResult>(
    steps: readonly DrizzleWriteStep<TSession, TResult>[],
    operation: string,
  ): Promise<readonly TResult[]> {
    const results: TResult[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step === undefined) throw new Error("Drizzle write step disappeared");
      try {
        results.push(await step(this.#database as unknown as TSession));
      } catch (cause) {
        throw new DrizzleWriteCoordinatorError(operation, index, "sequential", results, cause);
      }
    }
    return results;
  }
}
