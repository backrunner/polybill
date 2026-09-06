import { parseId, parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { canonicalWebhookEvent } from "../src/index.js";

describe("canonical event identity", () => {
  it("separates tenant, connection, environment and repeated resource updates", async () => {
    const tenantId = parseId<"TenantId">("ten_events01", "ten");
    const context = {
      tenantId,
      connection: {
        tenantId,
        id: parseId<"ConnectionId">("conn_events01", "conn"),
        provider: "stripe",
        environment: "test",
      },
      observedAt: parseIsoDateTime("2026-09-06T00:00:00.000Z"),
      lookup: { findCanonicalId: async () => undefined },
    } as const;
    const input = {
      context,
      event: { type: "subscription.updated", externalIds: { event: "delivery_1" }, payload: {} },
      type: "subscription.changed.v1",
      aggregateType: "subscription",
      aggregateId: "sub_events01",
    };
    const first = await canonicalWebhookEvent(input);
    const otherTenant = parseId<"TenantId">("ten_events02", "ten");
    const variants = [
      {
        ...input,
        context: {
          ...context,
          tenantId: otherTenant,
          connection: { ...context.connection, tenantId: otherTenant },
        },
      },
      {
        ...input,
        context: {
          ...context,
          connection: {
            ...context.connection,
            id: parseId<"ConnectionId">("conn_events02", "conn"),
          },
        },
      },
      {
        ...input,
        context: {
          ...context,
          connection: { ...context.connection, environment: "live" as const },
        },
      },
      { ...input, event: { ...input.event, externalIds: { event: "delivery_2" } } },
    ];
    const ids = await Promise.all(
      variants.map(async (value) => (await canonicalWebhookEvent(value)).id),
    );
    expect(new Set([first.id, ...ids]).size).toBe(5);
    expect((await canonicalWebhookEvent(input)).id).toBe(first.id);
  });
});
