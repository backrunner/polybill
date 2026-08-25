import { describe, expect, it } from "vitest";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../src/d1.js";
import { DefaultD1WriteCoordinator, D1WriteCoordinatorError } from "../src/write-coordinator.js";

function statement(run: () => Promise<D1Result>): D1PreparedStatement {
  return {
    bind() {
      return this;
    },
    first: async () => null,
    all: async () => ({ results: [] }),
    run,
  };
}

describe("D1 write coordinator", () => {
  it("executes sequential writes in order and reports partial failure", async () => {
    const order: number[] = [];
    const writes = new DefaultD1WriteCoordinator({} as D1DatabaseLike, { mode: "sequential" });
    const failure = new Error("offline");
    const statements = [
      statement(async () => {
        order.push(0);
        return { meta: { changes: 1 } };
      }),
      statement(async () => {
        order.push(1);
        throw failure;
      }),
      statement(async () => {
        order.push(2);
        return { meta: { changes: 1 } };
      }),
    ];
    await expect(writes.execute(statements, "checkout.commit")).rejects.toMatchObject({
      code: "d1_write_partial_failure",
      operation: "checkout.commit",
      completed: 1,
      cause: failure,
    });
    expect(order).toEqual([0, 1]);
  });

  it("delegates batch mode to the database", async () => {
    let calls = 0;
    const db: D1DatabaseLike = {
      prepare: () => statement(async () => ({ meta: { changes: 1 } })),
      batch: async (items) => {
        calls += 1;
        expect(items).toHaveLength(2);
        return items.map(() => ({ meta: { changes: 1 } }));
      },
    };
    const writes = new DefaultD1WriteCoordinator(db);
    await expect(writes.execute([db.prepare("a"), db.prepare("b")])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("preserves the original cause", async () => {
    const cause = new Error("boom");
    const writes = new DefaultD1WriteCoordinator({} as D1DatabaseLike, { mode: "sequential" });
    try {
      await writes.execute([
        statement(async () => {
          throw cause;
        }),
      ]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(D1WriteCoordinatorError);
      expect((error as D1WriteCoordinatorError).cause).toBe(cause);
    }
  });
});
