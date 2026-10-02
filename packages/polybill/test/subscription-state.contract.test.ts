import type { ProviderSubscriptionSnapshot } from "@polybill/adapter-kit";
import { PolybillError, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { end, later } from "./subscription-fixtures.js";
import {
  setup,
  id,
  priceId,
  nextPriceId,
  original,
  snapshot,
} from "./subscription-state-fixture.js";

describe("canonical subscription confirmation and recovery", () => {
  it("rejects a reconciliation target outside the connection mapping before provider reads", async () => {
    const { client, remote } = await setup(() => snapshot);
    await expect(
      client.reconcile.inspect({
        entityType: "subscription",
        entityId: id,
        externalId: "foreign_subscription",
      }),
    ).resolves.toMatchObject({ status: "failed", errorCode: "provider_response_invalid" });
    expect(remote).not.toHaveBeenCalled();
  });

  it.each([
    { ...snapshot, cancelAtPeriodEnd: true },
    { ...snapshot, collectionPause: { invoiceBehavior: "void" as const } },
    { ...snapshot, trialEnd: parseIsoDateTime(end) },
    { ...snapshot, resumesAt: parseIsoDateTime(later) },
    {
      ...snapshot,
      scheduledChange: {
        kind: "items" as const,
        effectiveAt: parseIsoDateTime(end),
        items: [{ externalPriceId: "remote_next_price", quantity: 5 }],
      },
    },
  ])("reconciles optional subscription state and its later removal", async (initial) => {
    let observed: ProviderSubscriptionSnapshot = initial;
    const { client, remote } = await setup(() => observed);
    const target = { entityType: "subscription" as const, entityId: id, externalId: "remote_sub" };
    const report = await client.reconcile.inspect(target);
    expect(report.status).toBe("different");
    const added = await client.reconcile.run({
      stream: "subscription-added",
      mode: "projection_only",
      idempotencyKey: parseIdempotencyKey("subscription:reconcile:add"),
    });
    expect(added.items.filter((item) => item.entityId === id)).toHaveLength(1);
    expect(added.items.find((item) => item.entityId === id)?.status).toBe("applied");
    if (initial.cancelAtPeriodEnd)
      expect((await client.subscriptions.get(id))?.accessUntil).toBe(end);
    expect((await client.reconcile.inspect(target)).status).toBe("matched");
    observed = snapshot;
    expect((await client.reconcile.inspect(target)).status).toBe("different");
    const removed = await client.reconcile.run({
      stream: "subscription-removed",
      mode: "projection_only",
      idempotencyKey: parseIdempotencyKey("subscription:reconcile:remove"),
    });
    expect(removed.items.find((item) => item.entityId === id)?.status).toBe("applied");
    expect((await client.reconcile.inspect(target)).status).toBe("matched");
    const final = await client.subscriptions.get(id);
    for (const field of [
      "scheduledChange",
      "collectionPause",
      "trialEnd",
      "resumesAt",
      "accessUntil",
    ] as const)
      expect(final?.[field]).toBeUndefined();
    expect(remote.mock.calls).toEqual(
      Array.from({ length: 8 }, () => [expect.anything(), "remote_sub"]),
    );
  });

  it.each([
    { ...snapshot, externalId: "foreign_subscription" },
    { ...snapshot, externalCustomerId: "foreign_customer" },
    { ...snapshot, items: [{ externalPriceId: "unmapped_price", quantity: 2 }] },
  ])("fails reconciliation for foreign or unmapped snapshots", async (observed) => {
    const { client } = await setup(() => observed);
    const report = await client.reconcile.run({
      stream: "invalid-subscription",
      mode: "projection_only",
      idempotencyKey: parseIdempotencyKey("subscription:reconcile:invalid"),
    });
    expect(report.items.find((item) => item.entityId === id)?.status).toBe("failed");
    expect(await client.subscriptions.get(id)).toEqual(original);
  });

  it("keeps current items until the authoritative snapshot applies a scheduled change", async () => {
    let observed: ProviderSubscriptionSnapshot = {
      ...snapshot,
      scheduledChange: {
        kind: "items",
        effectiveAt: parseIsoDateTime(end),
        items: [{ externalPriceId: "remote_next_price", quantity: 5 }],
      },
    };
    const { client, remote } = await setup(() => observed);
    const key = parseIdempotencyKey("subscription:scheduled:change");
    const args = [
      id,
      key,
      [{ priceId: nextPriceId, quantity: 5 }],
      { timing: "period_end", proration: "none" },
    ] as const;
    const scheduled = await client.subscriptions.changeItems(...args);
    expect(scheduled.items).toEqual(original.items);
    expect(scheduled.scheduledChange).toEqual({
      kind: "items",
      effectiveAt: end,
      items: [{ priceId: nextPriceId, quantity: 5 }],
    });
    await expect(client.subscriptions.changeItems(...args)).resolves.toEqual(scheduled);
    expect(remote).toHaveBeenCalledOnce();
    observed = { ...snapshot, items: [{ externalPriceId: "remote_next_price", quantity: 5 }] };
    const applied = await client.subscriptions.refresh(
      id,
      parseIdempotencyKey("subscription:scheduled:refresh"),
    );
    expect(applied.items).toEqual([{ priceId: nextPriceId, quantity: 5 }]);
    expect(applied.scheduledChange).toBeUndefined();
  });

  it("does not grant or repeat an immediate change that the provider has not confirmed", async () => {
    const { client, remote } = await setup(() => snapshot);
    const args = [
      id,
      parseIdempotencyKey("subscription:unconfirmed"),
      [{ priceId, quantity: 8 }],
      { timing: "immediately", proration: "none" },
    ] as const;
    await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(remote).toHaveBeenCalledOnce();
    expect((await client.subscriptions.get(id))?.items).toEqual(original.items);
  });

  it("does not report a scheduled change that the provider failed to schedule", async () => {
    const { client, remote } = await setup(() => snapshot);
    const args = [
      id,
      parseIdempotencyKey("subscription:missing:schedule"),
      [{ priceId, quantity: 8 }],
      { timing: "period_end", proration: "none" },
    ] as const;
    await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(remote).toHaveBeenCalledOnce();
  });

  it.each([
    {
      observed: { ...snapshot, items: [{ externalPriceId: "remote_price", quantity: 8 }] },
      quantity: 8,
    },
    {
      observed: {
        ...snapshot,
        scheduledChange: {
          kind: "items" as const,
          effectiveAt: parseIsoDateTime(end),
          items: [{ externalPriceId: "remote_next_price", quantity: 5 }],
        },
      },
      quantity: 2,
    },
  ])(
    "rejects a period-end change applied immediately or left with a conflicting schedule",
    async ({ observed, quantity }) => {
      const { client, remote } = await setup(() => observed);
      const args = [
        id,
        parseIdempotencyKey("subscription:timing:mismatch"),
        [{ priceId, quantity }],
        { timing: "period_end", proration: "none" },
      ] as const;
      await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
        code: "outcome_unknown",
      });
      await expect(client.subscriptions.changeItems(...args)).rejects.toMatchObject({
        code: "outcome_unknown",
      });
      expect(remote).toHaveBeenCalledOnce();
      expect(await client.subscriptions.get(id)).toEqual(original);
    },
  );

  it.each([
    { ...snapshot, externalCustomerId: "another_customer" },
    { ...snapshot, externalId: "another_subscription" },
    { ...snapshot, status: "unknown" as const },
  ])("rejects foreign or unknown provider snapshots", async (observed) => {
    const { client } = await setup(() => observed);
    await expect(
      client.subscriptions.refresh(id, parseIdempotencyKey("subscription:invalid")),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(await client.subscriptions.get(id)).toEqual(original);
  });

  it("retains collection state and allows replay after the requested resume date has passed", async () => {
    const observed: ProviderSubscriptionSnapshot = {
      ...snapshot,
      collectionPause: { invoiceBehavior: "void", resumesAt: parseIsoDateTime(later) },
      trialEnd: parseIsoDateTime(end),
    };
    const { client, remote, clock } = await setup(() => observed);
    const policy = {
      timing: "immediately",
      invoiceBehavior: "void",
      resumesAt: parseIsoDateTime(later),
    } as const;
    const key = parseIdempotencyKey("subscription:pause:replay");
    const paused = await client.subscriptions.pause(id, key, policy);
    expect(paused).toMatchObject({
      status: "active",
      collectionPause: observed.collectionPause,
      trialEnd: end,
    });
    clock.advance(90 * 24 * 60 * 60 * 1000);
    await expect(client.subscriptions.pause(id, key, policy)).resolves.toEqual(paused);
    expect(remote).toHaveBeenCalledOnce();
  });

  it("does not retry a response-lost mutation", async () => {
    const { client, remote } = await setup(() => {
      throw new PolybillError("Response lost", {
        code: "outcome_unknown",
        operation: "subscription.update",
        retryable: false,
      });
    });
    const key = parseIdempotencyKey("subscription:lost:trial");
    await expect(client.subscriptions.setTrialEnd(id, key, "now")).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await expect(client.subscriptions.setTrialEnd(id, key, "now")).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(remote).toHaveBeenCalledOnce();
  });
});
