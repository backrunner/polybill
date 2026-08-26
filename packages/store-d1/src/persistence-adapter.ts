import type {
  StatementWriteCoordinator,
  StatementWriteCoordinatorOptions,
} from "@polybill/store-drizzle";
import { DefaultStatementWriteCoordinator } from "@polybill/store-drizzle";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "./d1.js";

export type D1PersistenceWriter = StatementWriteCoordinator<D1PreparedStatement, D1Result>;

export function createD1PersistenceAdapter(
  db: D1DatabaseLike,
  options: StatementWriteCoordinatorOptions = {},
): D1PersistenceWriter {
  return new DefaultStatementWriteCoordinator(
    {
      batch: (statements) => db.batch(statements),
      run: (statement) => statement.run(),
    },
    options,
  );
}
