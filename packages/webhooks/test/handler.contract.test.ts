import type { ProviderAdapter } from "@polybill/adapter-kit";
import { PolybillError, parseId, parseIsoDateTime, type ConnectionRef } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createWebhookConsumer, createWebhookHandler, MemoryWebhookInbox } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_webhook01", "ten");
const connection: ConnectionRef = {
  id: parseId<"ConnectionId">("conn_webhook01", "conn"),
  tenantId,
  provider: "stripe",
  environment: "test",
};

function adapter(observed: Uint8Array[], mappedIds: (string | undefined)[] = []): ProviderAdapter {
  return {
    descriptor: {
      name: "stripe",
      displayName: "Stripe fixture",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async () => {
      throw new Error("unused");
    },
    webhooks: {
      async verify(input) {
        observed.push(Uint8Array.from(input.rawBody));
        if (input.headers.get("x-test-signature") !== input.secret.active) {
          throw new PolybillError("Invalid fixture signature", {
            code: "signature_invalid",
            operation: "webhook.verify",
            retryable: false,
          });
        }
        return {
          provider: "stripe",
          environment: input.environment,
          deliveryKey: input.headers.get("x-delivery-id") ?? "missing",
          providerEventId: "evt_fixture",
          rawBody: input.rawBody,
          verifiedAt: input.now,
          keyId: input.secret.activeKeyId,
        };
      },
      decode(event) {
        return {
          type: "payment.succeeded",
          externalIds: { payment: "pi_fixture" },
          payload: new TextDecoder().decode(event.rawBody),
        };
      },
      async map(event, context) {
        mappedIds.push(
          await context.lookup.findCanonicalId({
            tenantId: context.tenantId,
            connectionId: context.connection.id,
            entityType: "payment",
            externalId: event.externalIds.payment ?? "",
          }),
        );
        return [
          {
            id: parseId<"EventId">("evt_canonical01", "evt"),
            schemaVersion: 1,
            type: "payment.succeeded.v1",
            tenantId,
            connectionId: connection.id,
            environment: "test",
            aggregate: { type: "payment", id: "pay_fixture01" },
            occurredAt: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
            observedAt: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
            data: {},
            evidenceRef: parseId<"EvidenceId">("evi_webhook01", "evi"),
          },
        ];
      },
    },
    reconcile: { checkout: async () => [] },
  };
}

function request(body = '{\n  "type": "payment.succeeded"\n}', delivery = "delivery-1"): Request {
  return new Request("https://merchant.example/webhooks/polybill/stripe/conn_webhook01", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-signature": "fixture-secret",
      "x-delivery-id": delivery,
    },
    body,
  });
}

describe("unified webhook contract", () => {
  it("recovers queue dispatch failure and preserves applied state after a late failure", async () => {
    const inbox = new MemoryWebhookInbox();
    let fail = true;
    const handler = createWebhookHandler({
      adapters: new Map([["stripe", adapter([])]]),
      inbox,
      queue: {
        send: async (record) => {
          if (fail) {
            fail = false;
            throw new Error("queue down");
          }
          await inbox.send(record);
        },
      },
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
      now: () => "2026-08-25T00:00:00.000Z",
    });
    expect((await handler(request())).status).toBe(503);
    expect(inbox.queued).toHaveLength(0);
    expect((await handler(request())).status).toBe(202);
    expect(inbox.queued).toHaveLength(1);
    expect((await handler(request())).status).toBe(202);
    expect(inbox.queued).toHaveLength(1);
    const record = inbox.queued[0];
    if (record === undefined) throw new Error("missing queue record");
    await inbox.markApplied(record, []);
    await inbox.markFailed(record, "queue_dispatch_failed", true);
    expect((await handler(request())).status).toBe(204);
    expect(inbox.state(connection.id, record.deliveryKey)).toBe("applied");
  });

  it("recovers an inbox claim abandoned before queue dispatch after its lease expires", async () => {
    const inbox = new MemoryWebhookInbox();
    const verified = await adapter([]).webhooks.verify({
      rawBody: new TextEncoder().encode("{}"),
      headers: new Headers({ "x-test-signature": "fixture-secret", "x-delivery-id": "delivery-1" }),
      secret: { active: "fixture-secret", activeKeyId: "key-1" },
      environment: "test",
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    });
    await inbox.claim({
      tenantId,
      connection,
      deliveryKey: "delivery-1",
      receivedAt: verified.verifiedAt,
      verified,
    });
    const handler = createWebhookHandler({
      adapters: new Map([["stripe", adapter([])]]),
      inbox,
      queue: inbox,
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
      now: () => "2026-08-25T00:01:01.000Z",
    });
    expect((await handler(request("{}"))).status).toBe(202);
    expect(inbox.queued).toHaveLength(1);
  });

  it("returns 5xx when inbox persistence fails", async () => {
    class UnavailableInbox extends MemoryWebhookInbox {
      override async claim(): Promise<never> {
        throw new Error("database down");
      }
    }
    const inbox = new UnavailableInbox();
    const handler = createWebhookHandler({
      adapters: new Map([["stripe", adapter([])]]),
      inbox,
      queue: inbox,
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
    });
    expect((await handler(request())).status).toBe(503);
    expect(inbox.queued).toHaveLength(0);
  });

  it("verifies raw bytes, claims the inbox, and applies asynchronously", async () => {
    const observed: Uint8Array[] = [];
    const mappedIds: (string | undefined)[] = [];
    const inbox = new MemoryWebhookInbox();
    const adapters = new Map([["stripe", adapter(observed, mappedIds)]]);
    const handler = createWebhookHandler({
      adapters,
      inbox,
      queue: inbox,
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const body = '{\n  "type": "payment.succeeded"\n}';
    expect((await handler(request(body))).status).toBe(202);
    expect(new TextDecoder().decode(observed[0])).toBe(body);
    expect(inbox.queued).toHaveLength(1);

    const record = inbox.queued[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    await createWebhookConsumer({
      adapters,
      inbox,
      mappingStore: {
        findCanonicalId: async (_tenant, _connection, type, externalId) =>
          type === "payment" && externalId === "pi_fixture" ? "pay_fixture01" : undefined,
      },
    })(record);
    expect(inbox.state(connection.id, "delivery-1")).toBe("applied");
    expect(mappedIds).toEqual(["pay_fixture01"]);
  });

  it("deduplicates before queueing and rejects invalid signatures", async () => {
    const inbox = new MemoryWebhookInbox();
    const adapters = new Map([["stripe", adapter([])]]);
    const handler = createWebhookHandler({
      adapters,
      inbox,
      queue: inbox,
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
    });
    expect((await handler(request())).status).toBe(202);
    expect((await handler(request())).status).toBe(202);
    const invalid = request("{}", "delivery-invalid");
    invalid.headers.set("x-test-signature", "wrong");
    expect((await handler(invalid)).status).toBe(401);
    expect(inbox.queued).toHaveLength(1);
  });

  it("rejects an oversized body before verification", async () => {
    const observed: Uint8Array[] = [];
    const inbox = new MemoryWebhookInbox();
    const handler = createWebhookHandler({
      adapters: new Map([["stripe", adapter(observed)]]),
      inbox,
      queue: inbox,
      maxBodyBytes: 4,
      resolver: {
        resolve: async () => ({
          tenantId,
          connection,
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
    });
    expect((await handler(request("12345"))).status).toBe(413);
    expect(observed).toHaveLength(0);
  });

  it("keeps identical delivery keys isolated by tenant and environment", async () => {
    const inbox = new MemoryWebhookInbox();
    const observed: Uint8Array[] = [];
    const adapters = new Map([["stripe", adapter(observed)]]);
    const handler = createWebhookHandler({
      adapters,
      inbox,
      queue: inbox,
      resolver: {
        resolve: async ({ headers }) => ({
          tenantId:
            headers.get("x-tenant") === "other"
              ? parseId<"TenantId">("ten_webhook02", "ten")
              : tenantId,
          connection: {
            ...connection,
            tenantId:
              headers.get("x-tenant") === "other"
                ? parseId<"TenantId">("ten_webhook02", "ten")
                : tenantId,
            environment: headers.get("x-env") === "live" ? "live" : "test",
          },
          secret: { active: "fixture-secret", activeKeyId: "key-1" },
        }),
      },
    });
    const first = request('{"type":"payment.succeeded"}', "same-delivery");
    const second = request('{"type":"payment.succeeded"}', "same-delivery");
    second.headers.set("x-tenant", "other");
    second.headers.set("x-env", "live");
    await expect(handler(first)).resolves.toHaveProperty("status", 202);
    await expect(handler(second)).resolves.toHaveProperty("status", 202);
    expect(inbox.queued).toHaveLength(2);
  });
});
