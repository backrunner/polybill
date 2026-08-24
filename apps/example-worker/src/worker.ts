import type { InboxRecord } from "@polybill/webhooks";
import { D1ApplicationStore, D1WebhookInbox } from "@polybill/store-d1";
import { createWebhookConsumer, createWebhookHandler, providerSlug } from "@polybill/webhooks";
import { createPolybill } from "polybill";
import type { QueueBatch, WorkerEnv } from "./bindings.js";
import { configuredAdapters, connectionFromEnv } from "./config.js";
import { redemptionShard } from "./crypto.js";
import {
  deserializeInboxRecord,
  serializeInboxRecord,
  type SerializedInboxRecord,
} from "./queue-wire.js";
import { redeemInput, VoucherRedemptionCoordinator } from "./redemption-do.js";

export { VoucherRedemptionCoordinator };

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/webhooks/polybill/")) return webhookHandler(env)(request);
    if (url.pathname === "/capabilities" && request.method === "GET") {
      const connection = connectionFromEnv(env);
      const adapter = configuredAdapters(env).get(providerSlug(connection.provider));
      if (adapter === undefined)
        return Response.json({ code: "provider_not_configured" }, { status: 500 });
      const billing = createPolybill({
        tenantId: connection.tenantId,
        connection,
        credentials: { apiKey: env.POLYBILL_API_KEY },
        adapter,
        store: new D1ApplicationStore(env.POLYBILL_DB),
      });
      return Response.json(await billing.getCapabilities());
    }
    if (url.pathname === "/vouchers/redeem" && request.method === "POST") {
      try {
        const input = redeemInput(await request.json());
        const id = env.REDEMPTION_COORDINATOR.idFromName(
          `${env.POLYBILL_TENANT_ID}:${await redemptionShard(input.code)}`,
        );
        return env.REDEMPTION_COORDINATOR.get(id).fetch(
          new Request("https://redemption.internal/redeem", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        );
      } catch {
        return Response.json({ code: "invalid_request" }, { status: 400 });
      }
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  },

  async queue(batch: QueueBatch<SerializedInboxRecord>, env: WorkerEnv): Promise<void> {
    const inbox = new D1WebhookInbox(env.POLYBILL_DB);
    const consume = createWebhookConsumer({
      adapters: configuredAdapters(env),
      inbox,
      mappingStore: new D1ApplicationStore(env.POLYBILL_DB),
    });
    for (const message of batch.messages) {
      try {
        await consume(deserializeInboxRecord(message.body));
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};

export default worker;

function webhookHandler(env: WorkerEnv) {
  const connection = connectionFromEnv(env);
  return createWebhookHandler({
    adapters: configuredAdapters(env),
    inbox: new D1WebhookInbox(env.POLYBILL_DB),
    queue: {
      send: (record: InboxRecord) => env.POLYBILL_WEBHOOK_QUEUE.send(serializeInboxRecord(record)),
    },
    resolver: {
      resolve: async (input) =>
        input.provider === providerSlug(connection.provider) &&
        (input.connectionId === undefined || input.connectionId === connection.id)
          ? {
              tenantId: connection.tenantId,
              connection,
              secret: { active: env.POLYBILL_WEBHOOK_SECRET, activeKeyId: "worker-current" },
            }
          : undefined,
    },
  });
}
