import { parseId, parseIdempotencyKey, parseIsoDateTime, type UsageEvent } from "@polybill/core";
import {
  SubscriptionScheduleService,
  UsageService,
  type BillingRecord,
  type BillingScope,
} from "@polybill/application";
import { MemoryBillingStore } from "@polybill/store-memory";
import { describe, expect, it } from "vitest";
import {
  billingFixture,
  customerId,
  id,
  priceId,
  nextPriceId,
  snapshot,
} from "./billing-workflow-fixture.js";

const key = parseIdempotencyKey;
const due = parseIsoDateTime("2026-10-02T00:01:00.000Z");
const latest = parseIsoDateTime("2026-10-02T00:02:00.000Z");
const command = {
  subscriptionId: id,
  phases: [
    {
      executeAt: due,
      latestAt: latest,
      items: [{ priceId: nextPriceId, quantity: 3 }],
      proration: "none" as const,
    },
  ],
  idempotencyKey: key("schedule-command"),
};

describe("durable billing workflows", () => {
  it("polls authorization without webhooks and never fulfills from checkout completion", async () => {
    const f = await billingFixture();
    const created = await checkout(f);
    expect(await f.client.subscriptionAuthorizations.refresh(created.checkout.id)).toMatchObject({
      status: "pending",
    });
    f.setCheckout("complete");
    expect(await f.client.subscriptionAuthorizations.refresh(created.checkout.id)).toMatchObject({
      status: "bound",
      subscriptions: [{ id, status: "active" }],
    });
    expect(await f.client.payments.get(created.payment.id)).toMatchObject({ status: "pending" });
    expect(await f.client.orders.get(created.order.id)).toMatchObject({
      fulfillmentStatus: "unfulfilled",
    });
    f.setRemote({ ...snapshot, externalCustomerId: "foreign_customer" });
    await expect(
      f.client.subscriptionAuthorizations.refresh(created.checkout.id),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
  it("concurrent first bindings converge on one canonical identity", async () => {
    const f = await billingFixture(new MemoryBillingStore(), false);
    const created = await checkout(f);
    f.setCheckout("complete");
    const results = await Promise.allSettled([
      f.client.subscriptionAuthorizations.refresh(created.checkout.id),
      f.client.subscriptionAuthorizations.refresh(created.checkout.id),
    ]);
    const ids = results.flatMap((result) =>
      result.status === "fulfilled" && result.value.status === "bound"
        ? result.value.subscriptions.map((sub) => sub.id)
        : [],
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids.length).toBeGreaterThan(0);
    const stored = await f.store.findCanonicalId(
      f.context.tenantId,
      f.context.connection.id,
      "subscription",
      "remote_sub",
    );
    expect(stored).toBe(ids[0]);
  });
  it.each([
    ["expired", "expired"],
    ["canceled", "failed"],
  ] as const)("preserves %s authorization", async (remote, expected) => {
    const f = await billingFixture();
    const created = await checkout(f);
    f.setCheckout(remote);
    expect(await f.client.subscriptionAuthorizations.refresh(created.checkout.id)).toMatchObject({
      status: expected,
    });
  });
  it("executes due phases once across concurrent executors", async () => {
    const f = await billingFixture();
    const schedule = await f.schedules.create(command);
    expect(await f.schedules.runDue()).toEqual([]);
    f.clock.advance(60_000);
    await Promise.all([
      f.schedules.runDue(),
      new SubscriptionScheduleService(f.runtime, f.billing).runDue(),
    ]);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    expect(await f.schedules.get(schedule.id)).toMatchObject({ state: "complete", phase: 1 });
    expect(await f.schedules.create(command)).toMatchObject({ id: schedule.id, state: "complete" });
  });
  it("recovers a lost mutation response by read-back without reissuing it", async () => {
    const f = await billingFixture();
    const schedule = await f.schedules.create(command);
    f.setLost(true);
    f.clock.advance(60_000);
    expect(await f.schedules.runDue()).toMatchObject([{ errorCode: "outcome_unknown" }]);
    await expect(f.schedules.cancel(schedule.id)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(await new SubscriptionScheduleService(f.runtime, f.billing).runDue()).toMatchObject([
      { schedule: { state: "complete" } },
    ]);
    expect(f.mutate).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted creation after the execution window has passed", async () => {
    class InterruptedStore extends MemoryBillingStore {
      fail = true;
      override async putBillingRecord(scope: BillingScope, record: BillingRecord, version: number) {
        if (this.fail && record.kind === "schedule" && version === 1) {
          this.fail = false;
          throw new Error("Process interrupted");
        }
        return super.putBillingRecord(scope, record, version);
      }
    }
    const f = await billingFixture(new InterruptedStore());
    await expect(f.schedules.create(command)).rejects.toThrow("Process interrupted");
    f.clock.advance(180_000);
    const recovered = await f.schedules.create(command);
    expect(recovered.state).toBe("pending");
    expect(await f.schedules.runDue()).toMatchObject([
      { schedule: { state: "needs_review", reviewReason: "late_or_changed" } },
    ]);
    expect(f.mutate).not.toHaveBeenCalled();
    expect(await f.schedules.cancel(recovered.id)).toMatchObject({ state: "canceled" });
  });
  it("rejects overlapping schedules and disarms the rejected intent", async () => {
    const f = await billingFixture();
    const schedule = await f.schedules.create(command);
    await expect(
      f.schedules.create({ ...command, idempotencyKey: key("other-schedule") }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.clock.advance(180_000);
    expect(await f.schedules.runDue()).toMatchObject([
      { id: schedule.id, schedule: { state: "needs_review" } },
    ]);
    expect(f.mutate).not.toHaveBeenCalled();
    expect(await f.schedules.cancel(schedule.id)).toMatchObject({ state: "canceled" });
  });
  it("does not rearm an unowned schedule when another operation happens to match its items", async () => {
    const f = await billingFixture();
    await f.schedules.create(command);
    const competing = {
      ...command,
      idempotencyKey: key("competing-schedule"),
      phases: [
        ...command.phases,
        {
          executeAt: parseIsoDateTime("2026-10-02T00:03:00.000Z"),
          latestAt: parseIsoDateTime("2026-10-02T00:04:00.000Z"),
          items: [{ priceId, quantity: 1 }],
          proration: "none" as const,
        },
      ],
    };
    await expect(f.schedules.create(competing)).rejects.toMatchObject({ code: "conflict" });
    const rejected = await f.schedules.create(competing);
    f.setRemote({ ...snapshot, items: [{ externalPriceId: "remote_next_price", quantity: 3 }] });
    expect(await f.schedules.reconcile(rejected.id)).toMatchObject({
      state: "needs_review",
      reviewReason: "ownership_conflict",
      phase: 0,
    });
    f.clock.advance(180_000);
    await f.schedules.runDue();
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it("does not revive an expired execution window through read-back", async () => {
    const f = await billingFixture();
    const schedule = await f.schedules.create(command);
    f.clock.advance(180_000);
    await f.schedules.runDue();
    f.setRemote({ ...snapshot, items: [{ externalPriceId: "remote_next_price", quantity: 3 }] });
    expect(await f.schedules.reconcile(schedule.id)).toMatchObject({
      state: "needs_review",
      reviewReason: "late_or_changed",
      phase: 0,
    });
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it("prevents concurrent overspending and replays credits without applying twice", async () => {
    const f = await billingFixture();
    await f.credits.adjust({
      customerId,
      unit: "tokens",
      delta: "10",
      idempotencyKey: key("credit-grant"),
    });
    const results = await Promise.allSettled(
      ["debit-key-a", "debit-key-b"].map((idempotencyKey) =>
        f.credits.adjust({
          customerId,
          unit: "tokens",
          delta: "-8",
          idempotencyKey: key(idempotencyKey),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await f.credits.balance(customerId, "tokens")).toEqual({ balance: "2", revision: 2 });
    expect(
      await f.credits.adjust({
        customerId,
        unit: "tokens",
        delta: "10",
        idempotencyKey: key("credit-grant"),
      }),
    ).toMatchObject({ balance: "10", revision: 1 });
    await expect(
      f.credits.adjust({
        customerId,
        unit: "tokens",
        delta: "11",
        idempotencyKey: key("credit-grant"),
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("deduplicates usage, rejects changed intent and recovers by authoritative event lookup", async () => {
    const f = await billingFixture();
    const meter = await f.usage.createMeter({
      idempotencyKey: key("meter-create"),
      name: "API tokens",
      eventName: "api_tokens",
      unit: "tokens",
      aggregation: "sum",
      valueProperty: "quantity",
    });
    const event: UsageEvent = {
      id: parseId<"UsageEventId">("usage_fixture", "usage"),
      meterId: meter.id,
      customerId,
      quantity: "12",
      occurredAt: f.clock.now(),
    };
    f.setLost(true);
    await expect(f.usage.ingest(event)).rejects.toThrow("Response lost");
    expect(await new UsageService(f.runtime, f.billing).ingest(event)).toMatchObject({
      status: "accepted",
    });
    expect(await f.usage.ingest(event)).toMatchObject({ status: "accepted" });
    expect(f.ingest).toHaveBeenCalledTimes(1);
    await expect(f.usage.ingest({ ...event, quantity: "13" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

function checkout(f: Awaited<ReturnType<typeof billingFixture>>) {
  return f.client.checkouts.create({
    idempotencyKey: key("checkout-binding"),
    customerId,
    items: [{ priceId, quantity: 2 }],
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
  });
}
