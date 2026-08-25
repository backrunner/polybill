import { describe, expect, it } from "vitest";
import {
  DefaultDrizzleWriteCoordinator,
  DrizzleTransactionUnavailableError,
  DrizzleWriteCoordinatorError,
  type DrizzleDatabaseLike,
} from "../src/index.js";

interface FakeSession extends DrizzleDatabaseLike<FakeSession> {
  readonly values: number[];
}

function sequentialDatabase(): FakeSession {
  return { values: [] };
}

describe("Drizzle persistence coordinator", () => {
  it("runs replay-safe steps sequentially for databases without transactions", async () => {
    const database = sequentialDatabase();
    const coordinator = new DefaultDrizzleWriteCoordinator(database);
    const result = await coordinator.execute([
      async (session) => {
        session.values.push(1);
        return "first";
      },
      async (session) => {
        session.values.push(2);
        return "second";
      },
    ]);
    expect(result).toEqual(["first", "second"]);
    expect(database.values).toEqual([1, 2]);
    expect(coordinator.mode).toBe("sequential");
  });

  it("reports a partial sequential failure with operation context", async () => {
    const database = sequentialDatabase();
    const cause = new Error("write failed");
    const coordinator = new DefaultDrizzleWriteCoordinator(database, { mode: "sequential" });
    await expect(
      coordinator.execute(
        [
          async (session) => {
            session.values.push(1);
            return 1;
          },
          async () => {
            throw cause;
          },
        ],
        "refund.commit",
      ),
    ).rejects.toMatchObject({
      code: "persistence_write_partial_failure",
      operation: "refund.commit",
      completed: 1,
      mode: "sequential",
      cause,
    });
  });

  it("uses the Drizzle transaction callback as the atomic boundary", async () => {
    const calls: string[] = [];
    const database: FakeSession = {
      values: [],
      async transaction(work) {
        calls.push("begin");
        const transaction: FakeSession = { values: [] };
        const result = await work(transaction);
        calls.push("commit");
        return result;
      },
    };
    const coordinator = new DefaultDrizzleWriteCoordinator(database);
    await expect(
      coordinator.execute([
        async (session) => {
          session.values.push(1);
          return session.values.length;
        },
      ]),
    ).resolves.toEqual([1]);
    expect(calls).toEqual(["begin", "commit"]);
  });

  it("preserves the database receiver when invoking transaction", async () => {
    const database: FakeSession = {
      values: [],
      async transaction(work) {
        if (this.values === undefined) throw new Error("receiver lost");
        return work(this);
      },
    };
    const coordinator = new DefaultDrizzleWriteCoordinator(database);
    await expect(coordinator.execute([async (session) => session.values.length])).resolves.toEqual([
      0,
    ]);
  });

  it("preserves the database receiver when invoking transaction", async () => {
    const database: FakeSession = {
      values: [],
      async transaction(work) {
        if (this.values.length !== 0) throw new Error("missing database receiver");
        return work(this);
      },
    };
    const coordinator = new DefaultDrizzleWriteCoordinator(database);
    await expect(
      coordinator.execute([
        async (session) => {
          session.values.push(1);
          return session.values.length;
        },
      ]),
    ).resolves.toEqual([1]);
  });

  it("can require transactions instead of silently weakening atomicity", async () => {
    const database = sequentialDatabase();
    const coordinator = new DefaultDrizzleWriteCoordinator(database, { mode: "transaction" });
    await expect(coordinator.execute([async () => 1], "checkout.commit")).rejects.toBeInstanceOf(
      DrizzleTransactionUnavailableError,
    );
  });

  it("falls back explicitly when configured", async () => {
    const database = sequentialDatabase();
    const coordinator = new DefaultDrizzleWriteCoordinator(database, {
      mode: "transaction",
      fallbackToSequential: true,
    });
    expect(coordinator.mode).toBe("sequential");
    await expect(coordinator.execute([async () => "ok"])).resolves.toEqual(["ok"]);
  });

  it("wraps transaction failures without claiming completed steps", async () => {
    const cause = new Error("rollback");
    const database: FakeSession = {
      values: [],
      async transaction() {
        throw cause;
      },
    };
    const coordinator = new DefaultDrizzleWriteCoordinator(database);
    try {
      await coordinator.execute([async () => 1], "checkout.commit");
      throw new Error("expected transaction failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DrizzleWriteCoordinatorError);
      expect(error).toMatchObject({ completed: 0, mode: "transaction", cause });
    }
  });
});
