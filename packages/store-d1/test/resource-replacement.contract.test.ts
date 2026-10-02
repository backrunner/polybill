import { readFile } from "node:fs/promises";
import type { ResourceReplacement } from "@polybill/application";
import { parseId, parseIsoDateTime } from "@polybill/core";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1ApplicationStore, type D1DatabaseLike } from "../src/index.js";
import { createD1PersistenceAdapter } from "../src/persistence-adapter.js";

const replacement: ResourceReplacement = {
  tenantId: parseId<"TenantId">("ten_snapshotcas", "ten"),
  connectionId: parseId<"ConnectionId">("conn_snapshotcas", "conn"),
  provider: "stripe",
  entityType: "subscription",
  entityId: "sub_snapshotcas",
  externalId: "sub_remote",
  expectedVersion: 1,
  value: { version: 2 },
  occurredAt: parseIsoDateTime("2026-10-02T00:00:00.000Z"),
};

describe("D1 version-checked resource replacement", () => {
  let miniflare: Miniflare;
  let db: D1DatabaseLike;
  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: { DB: "snapshot-cas" },
    });
    const binding = await miniflare.getD1Database("DB");
    db = binding;
    const sql = await readFile(
      new URL("../migrations/0001_control_plane.sql", import.meta.url),
      "utf8",
    );
    await binding.exec(sql.replaceAll(/\s+/g, " "));
    await new D1ApplicationStore(db).commitResource({ ...replacement, value: { version: 1 } });
  });
  afterEach(async () => {
    await miniflare.dispose();
  });

  it.each(["batch", "sequential"] as const)(
    "allows exactly one concurrent writer in %s mode",
    async (mode) => {
      const make = () =>
        new D1ApplicationStore(db, { writes: createD1PersistenceAdapter(db, { mode }) });
      // Legacy physical revisions and canonical versions need not be equal.
      await db.prepare("UPDATE polybill_snapshots SET version = 7").run();
      const result = await Promise.allSettled([
        make().replaceResource(replacement),
        make().replaceResource(replacement),
      ]);
      expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(result.find((entry) => entry.status === "rejected")).toMatchObject({
        reason: { code: "conflict" },
      });
      expect(
        await make().getResource(replacement.tenantId, "subscription", replacement.entityId),
      ).toEqual({ version: 2 });
      expect(await db.prepare("SELECT version FROM polybill_snapshots").first()).toEqual({
        version: 8,
      });
      await expect(make().replaceResource(replacement)).rejects.toMatchObject({ code: "conflict" });
    },
  );

  it.each([
    { connectionId: parseId<"ConnectionId">("conn_foreigncas", "conn") },
    { tenantId: parseId<"TenantId">("ten_foreigncas", "ten") },
    { externalId: "sub_foreign" },
  ])("rejects a replacement outside the stored mapping scope", async (patch) => {
    const store = new D1ApplicationStore(db);
    await expect(store.replaceResource({ ...replacement, ...patch })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await store.getResource(replacement.tenantId, "subscription", replacement.entityId),
    ).toEqual({ version: 1 });
    const count = await db
      .prepare(
        "SELECT count(*) AS count FROM polybill_audit WHERE operation = 'subscription.observe'",
      )
      .first();
    expect(count).toEqual({ count: 0 });
  });

  it("requires the next canonical version without changing the snapshot", async () => {
    const store = new D1ApplicationStore(db);
    await expect(store.replaceResource({ ...replacement, value: { version: 3 } })).rejects.toThrow(
      "Invalid resource replacement version",
    );
    expect(
      await store.getResource(replacement.tenantId, "subscription", replacement.entityId),
    ).toEqual({ version: 1 });
  });

  it("insert-only recovery cannot overwrite a newer snapshot or rebind its mapping", async () => {
    const store = new D1ApplicationStore(db);
    await store.replaceResource(replacement);
    await store.insertResource({ ...replacement, value: { version: 1 } });
    expect(
      await store.getResource(replacement.tenantId, "subscription", replacement.entityId),
    ).toEqual({ version: 2 });
    await expect(
      store.insertResource({
        ...replacement,
        externalId: "foreign_subscription",
        value: { version: 1 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.insertResource({ ...replacement, entityId: "sub_duplicate", value: { version: 1 } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await store.getResource(replacement.tenantId, "subscription", "sub_duplicate"),
    ).toBeUndefined();
  });

  it("recovers a snapshot missing after an interrupted mapping insert", async () => {
    await db.prepare("DELETE FROM polybill_snapshots").run();
    const store = new D1ApplicationStore(db);
    await store.insertResource({ ...replacement, value: { version: 1 } });
    expect(
      await store.getResource(replacement.tenantId, "subscription", replacement.entityId),
    ).toEqual({ version: 1 });
  });
});
