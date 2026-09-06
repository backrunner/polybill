import type { MappingLookup, ProviderAdapter } from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import {
  createApplicationStoreMappingLookup,
  type ApplicationMappingStore,
} from "./mapping-lookup.js";
import type { InboxRecord, WebhookInboxStore } from "./ports.js";

export interface WebhookConsumerOptions {
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly inbox: WebhookInboxStore;
  readonly lookup?: MappingLookup;
  readonly mappingStore?: ApplicationMappingStore;
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
      const parsed = adapter.webhooks.decode(record.verified);
      const decoded = {
        ...parsed,
        externalIds: { ...parsed.externalIds, event: record.deliveryKey },
      };
      const events = await adapter.webhooks.map(decoded, {
        tenantId: record.tenantId,
        connection: record.connection,
        observedAt: record.receivedAt,
        lookup:
          options.lookup ??
          (options.mappingStore === undefined
            ? emptyLookup
            : createApplicationStoreMappingLookup(options.mappingStore)),
      });
      await options.inbox.markApplied(record, events);
    } catch (error) {
      const errorCode =
        error instanceof PolybillError
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown_error";
      await options.inbox.markFailed(record, errorCode, true);
      throw error;
    }
  };
}

const emptyLookup: MappingLookup = {
  findCanonicalId: async () => undefined,
};
