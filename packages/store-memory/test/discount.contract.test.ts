import { DiscountService } from "@polybill/application";
import {
  money,
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type TenantId,
} from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createMemoryDiscountStore } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_discount01", "ten");
const otherTenantId = parseId<"TenantId">("ten_discount02", "ten");

describe("memory discount store contract", () => {
  it("normalizes codes and safely replays create commands", async () => {
    const store = createMemoryDiscountStore();
    const service = setup(store, tenantId);
    const command = {
      idempotencyKey: parseIdempotencyKey("discount:create:0001"),
      code: " save10 ",
      name: "Save ten",
      value: { kind: "percentage" as const, basisPoints: 1_000 },
    };
    const created = await service.create(command);

    await expect(service.create({ ...command, code: "SAVE10" })).resolves.toEqual(created);
    await expect(service.create({ ...command, name: "Different payload" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(service.findByCode(" save10 ")).resolves.toEqual(created);
  });

  it("isolates tenants, enforces code uniqueness, and replays archives", async () => {
    const store = createMemoryDiscountStore();
    const service = setup(store, tenantId);
    const other = setup(store, otherTenantId);
    const created = await service.create({
      idempotencyKey: parseIdempotencyKey("discount:create:tenant-one"),
      code: "FIXED5",
      name: "Five dollars",
      value: { kind: "fixed", amount: money("500", "USD") },
    });
    await expect(
      service.create({
        idempotencyKey: parseIdempotencyKey("discount:create:duplicate"),
        code: "FIXED5",
        name: "Duplicate",
        value: { kind: "fixed", amount: money("500", "USD") },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(other.get(created.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      other.create({
        idempotencyKey: parseIdempotencyKey("discount:create:tenant-two"),
        code: "FIXED5",
        name: "Other tenant",
        value: { kind: "fixed", amount: money("500", "USD") },
      }),
    ).resolves.toMatchObject({ code: "FIXED5" });

    const key = parseIdempotencyKey("discount:archive:0001");
    const archived = await service.archive(created.id, key);
    await expect(service.archive(created.id, key)).resolves.toEqual(archived);
    await expect(
      service.archive(parseId<"DiscountId">("disc_another01", "disc"), key),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});

function setup(store: ReturnType<typeof createMemoryDiscountStore>, scopedTenantId: TenantId) {
  let sequence = 0;
  return new DiscountService({
    tenantId: scopedTenantId,
    store,
    crypto: {
      async sha256(value) {
        return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
      randomBytes(length) {
        return new Uint8Array(length).fill(7);
      },
      timingSafeEqual(left, right) {
        if (left.length !== right.length) return false;
        let difference = 0;
        for (let index = 0; index < left.length; index += 1)
          difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
        return difference === 0;
      },
    },
    ids: { next: (prefix) => `${prefix}_${String(++sequence).padStart(12, "0")}` },
    clock: { now: () => parseIsoDateTime("2026-08-25T00:00:00.000Z") },
  });
}
