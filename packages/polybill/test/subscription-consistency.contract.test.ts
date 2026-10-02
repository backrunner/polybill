import type { ProviderSubscriptionSnapshot } from "@polybill/adapter-kit";
import { parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { setup, id, snapshot, original } from "./subscription-state-fixture.js";
import { end, later } from "./subscription-fixtures.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("subscription consistency across commands and reconciliation", () => {
  it("keeps a canceled subscription terminal across stale reads and mutation attempts", async () => {
    const { client, store, context, remote } = await setup(() => snapshot);
    const canceled = { ...original, status: "canceled" as const, version: 2 };
    await store.commitResource({
      tenantId: context.tenantId,
      connectionId: context.connection.id,
      provider: "fake",
      entityType: "subscription",
      entityId: id,
      externalId: "remote_sub",
      value: canceled,
      occurredAt: context.clock.now(),
    });
    await expect(
      client.subscriptions.refresh(id, parseIdempotencyKey("terminal:stale:read")),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    await expect(
      client.subscriptions.resume(id, parseIdempotencyKey("terminal:resume")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(remote).toHaveBeenCalledOnce();
    expect(await client.subscriptions.get(id)).toEqual(canceled);
  });

  it.each([
    { status: "future_status" },
    { currentPeriodStart: later, currentPeriodEnd: end },
    { trialEnd: "invalid" },
    { scheduledChange: { kind: "future_change", effectiveAt: end } },
    { collectionPause: { invoiceBehavior: "future_behavior" } },
  ])("rejects malformed provider snapshot fields before storage", async (patch) => {
    const invalid = Object.assign(globalThis.structuredClone(snapshot), patch);
    const { client } = await setup(() => invalid);
    await expect(
      client.subscriptions.refresh(id, parseIdempotencyKey("invalid:snapshot")),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(await client.subscriptions.get(id)).toEqual(original);
  });

  it("does not retain a future cancellation schedule after terminal cancellation", async () => {
    const { client } = await setup(() => ({
      ...snapshot,
      status: "canceled",
      cancelAtPeriodEnd: true,
      scheduledChange: { kind: "cancel", effectiveAt: parseIsoDateTime(end) },
    }));
    const result = await client.subscriptions.refresh(
      id,
      parseIdempotencyKey("terminal:cancel:fields"),
    );
    expect(result.status).toBe("canceled");
    expect(result.accessUntil).toBeUndefined();
    expect(result.scheduledChange).toBeUndefined();
  });

  it("does not let a delayed read overwrite a newer cancellation", async () => {
    const waiting = deferred<ProviderSubscriptionSnapshot>();
    const started = deferred<void>();
    let reads = 0;
    const canceled = { ...snapshot, status: "canceled" as const, rawStatus: "canceled" };
    const { client } = await setup(async () => {
      if (reads++ === 0) {
        started.resolve();
        return waiting.promise;
      }
      return canceled;
    });
    const key = parseIdempotencyKey("subscription:concurrent:read");
    const slow = client.subscriptions.refresh(id, key);
    const failure = expect(slow).rejects.toMatchObject({
      code: "conflict",
      operation: "resource.replace",
    });
    await started.promise;
    const latest = await client.subscriptions.cancel(
      id,
      parseIdempotencyKey("subscription:concurrent:cancel"),
      "immediately",
    );
    waiting.resolve(snapshot);
    await failure;
    expect(await client.subscriptions.get(id)).toEqual(latest);
    await expect(client.subscriptions.refresh(id, key)).resolves.toMatchObject({
      status: "canceled",
      version: 3,
    });
  });

  it("does not replay a mutation that lost the snapshot version race", async () => {
    const waiting = deferred<ProviderSubscriptionSnapshot>();
    const started = deferred<void>();
    let calls = 0;
    const { client, remote } = await setup(async () => {
      if (calls++ === 0) {
        started.resolve();
        return waiting.promise;
      }
      return { ...snapshot, trialEnd: parseIsoDateTime(later) };
    });
    const key = parseIdempotencyKey("subscription:concurrent:mutation");
    const slow = client.subscriptions.setTrialEnd(id, key, parseIsoDateTime(end));
    const failure = expect(slow).rejects.toMatchObject({
      code: "outcome_unknown",
      retryable: false,
    });
    await started.promise;
    const latest = await client.subscriptions.refresh(
      id,
      parseIdempotencyKey("subscription:concurrent:newer"),
    );
    waiting.resolve({ ...snapshot, trialEnd: parseIsoDateTime(end) });
    await failure;
    await expect(
      client.subscriptions.setTrialEnd(id, key, parseIsoDateTime(end)),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(remote).toHaveBeenCalledTimes(2);
    expect(await client.subscriptions.get(id)).toEqual(latest);
  });

  it("cycles a completed scan and isolates report-only from projection checkpoints", async () => {
    let observed = snapshot;
    const { client } = await setup(() => observed);
    const input = {
      stream: "poll-subscriptions",
      idempotencyKey: parseIdempotencyKey("a".repeat(255)),
    };
    await client.reconcile.run({ ...input, mode: "report_only" });
    observed = { ...snapshot, cancelAtPeriodEnd: true };
    const applied = await client.reconcile.run({ ...input, mode: "projection_only" });
    expect(applied.items.find((item) => item.entityId === id)?.status).toBe("applied");
    const terminal = await client.reconcile.run({ ...input, mode: "projection_only" });
    expect(terminal.items).toEqual([]);
    expect(terminal.cursor).toBeUndefined();
    observed = snapshot;
    const next = await client.reconcile.run({ ...input, mode: "projection_only" });
    expect(next.items.find((item) => item.entityId === id)?.status).toBe("applied");
    expect(next.sequence).toBeGreaterThan(applied.sequence);
    expect((await client.subscriptions.get(id))?.scheduledChange).toBeUndefined();
  });

  it("uses distinct child keys for two streams sharing a caller key", async () => {
    let observed = { ...snapshot, trialEnd: parseIsoDateTime(end) };
    const { client } = await setup(() => observed);
    const input = {
      mode: "projection_only" as const,
      idempotencyKey: parseIdempotencyKey("shared:reconcile:key"),
    };
    await client.reconcile.run({ ...input, stream: "first" });
    observed = { ...snapshot, trialEnd: parseIsoDateTime(later) };
    const report = await client.reconcile.run({ ...input, stream: "second" });
    expect(report.items.find((item) => item.entityId === id)?.status).toBe("applied");
    expect((await client.subscriptions.get(id))?.trialEnd).toBe(later);
  });

  const cases = [
    { action: "cancel" as const, observed: snapshot },
    { action: "pause" as const, observed: snapshot },
    { action: "resume" as const, observed: { ...snapshot, status: "paused" as const } },
    { action: "clear" as const, observed: { ...snapshot, cancelAtPeriodEnd: true } },
    { action: "trial" as const, observed: { ...snapshot, trialEnd: parseIsoDateTime(end) } },
  ];
  it.each(cases)(
    "does not complete or repeat an unconfirmed $action",
    async ({ action, observed }) => {
      const { client, remote } = await setup(() => observed);
      const key = parseIdempotencyKey(`unconfirmed:lifecycle:${action}`);
      const run = () => {
        switch (action) {
          case "cancel":
            return client.subscriptions.cancel(id, key, "immediately");
          case "pause":
            return client.subscriptions.pause(id, key, {
              timing: "immediately",
              invoiceBehavior: "stop_billing",
            });
          case "resume":
            return client.subscriptions.resume(id, key);
          case "clear":
            return client.subscriptions.clearScheduledChange(id, key, "cancel");
          case "trial":
            return client.subscriptions.setTrialEnd(id, key, parseIsoDateTime(later));
        }
      };
      await expect(run()).rejects.toMatchObject({ code: "outcome_unknown" });
      await expect(run()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(remote).toHaveBeenCalledOnce();
      expect(await client.subscriptions.get(id)).toEqual(original);
    },
  );
});
