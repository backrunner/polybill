import type { CanonicalBillingEvent } from "@polybill/core";
import type { InboxClaim, InboxRecord, WebhookInboxStore, WebhookQueue } from "./ports.js";

interface StoredInbox {
  readonly record: InboxRecord;
  state: "processing" | "retry_wait" | "dead_letter" | "applied";
  attempts: number;
  events: readonly CanonicalBillingEvent[];
  errorCode?: string;
}

export class MemoryWebhookInbox implements WebhookInboxStore, WebhookQueue {
  readonly #records = new Map<string, StoredInbox>();
  readonly #queued: InboxRecord[] = [];

  get queued(): readonly InboxRecord[] {
    return this.#queued.map((record) => globalThis.structuredClone(record));
  }

  async claim(record: InboxRecord): Promise<InboxClaim> {
    const key = `${record.tenantId}:${record.connection.id}:${record.connection.environment}:${record.deliveryKey}`;
    const existing = this.#records.get(key);
    if (existing !== undefined)
      return existing.state === "applied" ? "duplicate_applied" : "duplicate_processing";
    this.#records.set(key, {
      record: globalThis.structuredClone(record),
      state: "processing",
      attempts: 0,
      events: [],
    });
    return "claimed";
  }

  async send(record: InboxRecord): Promise<void> {
    this.#queued.push(globalThis.structuredClone(record));
  }

  async markApplied(record: InboxRecord, events: readonly CanonicalBillingEvent[]): Promise<void> {
    const existing = this.#require(record);
    existing.state = "applied";
    existing.attempts += 1;
    existing.events = globalThis.structuredClone(events);
  }

  async markFailed(record: InboxRecord, errorCode: string, retryable: boolean): Promise<void> {
    const existing = this.#require(record);
    existing.state = retryable ? "retry_wait" : "dead_letter";
    existing.attempts += 1;
    existing.errorCode = errorCode;
  }

  state(connectionId: string, deliveryKey: string): StoredInbox["state"] | undefined {
    const entry = [...this.#records.entries()].find(([key]) => {
      const parts = key.split(":");
      return parts[1] === connectionId && parts[3] === deliveryKey;
    });
    return entry?.[1].state;
  }

  #require(record: InboxRecord): StoredInbox {
    const existing = this.#records.get(
      `${record.tenantId}:${record.connection.id}:${record.connection.environment}:${record.deliveryKey}`,
    );
    if (existing === undefined) throw new Error("Inbox record was not claimed");
    return existing;
  }
}
