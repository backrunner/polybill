import type { CanonicalBillingEvent } from "@polybill/core";
import type { InboxClaim, InboxRecord, WebhookInboxStore, WebhookQueue } from "./ports.js";

interface StoredInbox {
  readonly record: InboxRecord;
  state: "processing" | "retry_wait" | "dead_letter" | "applied";
  attempts: number;
  events: readonly CanonicalBillingEvent[];
  errorCode?: string;
  dispatchLeaseUntil: number | undefined;
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
    if (existing !== undefined) {
      const original = existing.record.verified.rawBody;
      const sameBody =
        original.length === record.verified.rawBody.length &&
        original.every((byte, index) => byte === record.verified.rawBody[index]);
      if (
        sameBody &&
        existing.state !== "applied" &&
        existing.dispatchLeaseUntil !== undefined &&
        existing.dispatchLeaseUntil <= Date.parse(record.receivedAt)
      ) {
        existing.dispatchLeaseUntil = Date.parse(record.receivedAt) + 60_000;
        existing.state = "processing";
        return "claimed";
      }
      return existing.state === "applied" ? "duplicate_applied" : "duplicate_processing";
    }
    this.#records.set(key, {
      record: globalThis.structuredClone(record),
      state: "processing",
      attempts: 0,
      events: [],
      dispatchLeaseUntil: Date.parse(record.receivedAt) + 60_000,
    });
    return "claimed";
  }

  async send(record: InboxRecord): Promise<void> {
    this.#queued.push(globalThis.structuredClone(record));
  }

  async markQueued(record: InboxRecord): Promise<void> {
    this.#require(record).dispatchLeaseUntil = undefined;
  }

  async markApplied(record: InboxRecord, events: readonly CanonicalBillingEvent[]): Promise<void> {
    const existing = this.#require(record);
    existing.state = "applied";
    existing.attempts += 1;
    existing.events = globalThis.structuredClone(events);
  }

  async markFailed(record: InboxRecord, errorCode: string, retryable: boolean): Promise<void> {
    const existing = this.#require(record);
    if (existing.state === "applied") return;
    existing.state = retryable ? "retry_wait" : "dead_letter";
    if (errorCode === "queue_dispatch_failed") existing.dispatchLeaseUntil = 0;
    existing.attempts += 1;
    existing.errorCode = errorCode;
  }

  state(connectionId: string, deliveryKey: string): StoredInbox["state"] | undefined {
    return [...this.#records.values()].find(
      ({ record }) => record.connection.id === connectionId && record.deliveryKey === deliveryKey,
    )?.state;
  }

  #require(record: InboxRecord): StoredInbox {
    const existing = this.#records.get(
      `${record.tenantId}:${record.connection.id}:${record.connection.environment}:${record.deliveryKey}`,
    );
    if (existing === undefined) throw new Error("Inbox record was not claimed");
    return existing;
  }
}
