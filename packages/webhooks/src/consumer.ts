import type { MappingLookup, ProviderAdapter } from "@polybill/adapter-kit";
import type { InboxRecord, WebhookInboxStore } from "./ports.js";

export interface WebhookConsumerOptions {
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly inbox: WebhookInboxStore;
  readonly lookup?: MappingLookup;
}

export function createWebhookConsumer(
  options: WebhookConsumerOptions,
): (record: InboxRecord) => Promise<void> {
  return async (record) => {
    const adapter = options.adapters.get(
      record.connection.provider === "lemonSqueezy" ? "lemon-squeezy" : record.connection.provider,
    );
    if (adapter === undefined) {
      await options.inbox.markFailed(record, "adapter_not_configured", false);
      return;
    }
    try {
      const decoded = adapter.webhooks.decode(record.verified);
      const events = await adapter.webhooks.map(decoded, {
        tenantId: record.tenantId,
        connection: record.connection,
        observedAt: record.receivedAt,
        lookup: options.lookup ?? emptyLookup,
      });
      await options.inbox.markApplied(record, events);
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : "unknown_error";
      await options.inbox.markFailed(record, errorCode, true);
      throw error;
    }
  };
}

const emptyLookup: MappingLookup = {
  findCanonicalId: async () => undefined,
};
