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

function adapter(observed: Uint8Array[]): ProviderAdapter {
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
          environment: "test",
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
      async map() {
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
  it("verifies raw bytes, claims the inbox, and applies asynchronously", async () => {
    const observed: Uint8Array[] = [];
    const inbox = new MemoryWebhookInbox();
    const adapters = new Map([["stripe", adapter(observed)]]);
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
    await createWebhookConsumer({ adapters, inbox })(record);
    expect(inbox.state(connection.id, "delivery-1")).toBe("applied");
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
});
