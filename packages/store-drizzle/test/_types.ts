import { drizzle, type D1Transaction, type DrizzleD1Database } from "drizzle-orm/d1";
import { DefaultDrizzleWriteCoordinator } from "../src/index.js";

declare const d1: Parameters<typeof drizzle>[0];
const db = drizzle(d1);
const coordinator = new DefaultDrizzleWriteCoordinator<
  DrizzleD1Database<Record<string, never>> & { $client: typeof d1 },
  D1Transaction<Record<string, never>, never>
>(db);
void coordinator.execute([
  async (session) => {
    await session.transaction(async (tx: D1Transaction<Record<string, never>, never>) => tx);
    return 1;
  },
]);
