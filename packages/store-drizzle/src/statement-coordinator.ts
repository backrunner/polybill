export type StatementWriteMode = "batch" | "sequential";

export interface StatementWriteBackend<TStatement, TResult> {
  readonly batch?: (statements: readonly TStatement[]) => Promise<readonly TResult[]>;
  readonly run: (statement: TStatement) => Promise<TResult>;
}

export interface StatementWriteCoordinatorOptions {
  readonly mode?: StatementWriteMode;
  readonly fallbackToSequential?: boolean;
}

export interface StatementWriteCoordinator<TStatement, TResult> {
  readonly mode: StatementWriteMode;
  execute(statements: readonly TStatement[], operation?: string): Promise<readonly TResult[]>;
}

export class StatementWriteCoordinatorError extends Error {
  readonly code = "persistence_write_partial_failure" as const;
  readonly operation: string;
  readonly completed: number;
  readonly mode: StatementWriteMode;
  readonly results: readonly unknown[];
  override readonly cause: unknown;

  constructor(
    operation: string,
    completed: number,
    mode: StatementWriteMode,
    results: readonly unknown[],
    cause: unknown,
  ) {
    super(`Persistence operation ${operation} failed after ${completed} statement(s)`);
    this.name = "StatementWriteCoordinatorError";
    this.operation = operation;
    this.completed = completed;
    this.mode = mode;
    this.results = results;
    this.cause = cause;
  }
}

export class StatementBatchUnavailableError extends Error {
  readonly code = "persistence_batch_unavailable" as const;
  readonly operation: string;

  constructor(operation: string) {
    super(`Statement backend does not expose batch execution for ${operation}`);
    this.name = "StatementBatchUnavailableError";
    this.operation = operation;
  }
}

export class DefaultStatementWriteCoordinator<
  TStatement,
  TResult,
> implements StatementWriteCoordinator<TStatement, TResult> {
  readonly #backend: StatementWriteBackend<TStatement, TResult>;
  readonly #fallbackToSequential: boolean;
  readonly mode: StatementWriteMode;

  constructor(
    backend: StatementWriteBackend<TStatement, TResult>,
    options: StatementWriteCoordinatorOptions = {},
  ) {
    this.#backend = backend;
    this.#fallbackToSequential = options.fallbackToSequential ?? false;
    const hasBatch = backend.batch !== undefined;
    const requestedMode = options.mode ?? (hasBatch ? "batch" : "sequential");
    this.mode =
      requestedMode === "batch" && !hasBatch && options.fallbackToSequential === true
        ? "sequential"
        : requestedMode;
  }

  async execute(
    statements: readonly TStatement[],
    operation = "persistence.write",
  ): Promise<readonly TResult[]> {
    if (statements.length === 0) return [];
    if (this.mode === "batch") {
      const batch = this.#backend.batch;
      if (batch === undefined) {
        if (!this.#fallbackToSequential) throw new StatementBatchUnavailableError(operation);
      } else {
        try {
          return await batch.call(this.#backend, statements);
        } catch (cause) {
          throw new StatementWriteCoordinatorError(operation, 0, "batch", [], cause);
        }
      }
    }
    const results: TResult[] = [];
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      if (statement === undefined) throw new Error("Persistence statement disappeared");
      try {
        results.push(await this.#backend.run(statement));
      } catch (cause) {
        throw new StatementWriteCoordinatorError(operation, index, "sequential", results, cause);
      }
    }
    return results;
  }
}
