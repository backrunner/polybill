import type { CanonicalBillingEvent } from "@polybill/core";
import type { InboxClaim, InboxRecord, WebhookInboxStore } from "@polybill/webhooks";
import { DefaultD1WriteCoordinator, type D1WriteCoordinator } from "./write-coordinator.js";

export interface D1Result<T = unknown> {
  readonly results?: readonly T[];
  readonly success?: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}
export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]>;
}

export interface D1InboxRow {
  readonly state: "processing" | "retry_wait" | "dead_letter" | "applied";
}

export class D1WebhookInbox implements WebhookInboxStore {
  readonly #db: D1DatabaseLike;
  readonly #writes: D1WriteCoordinator;

  constructor(db: D1DatabaseLike, options: { readonly writes?: D1WriteCoordinator } = {}) {
    this.#db = db;
    this.#writes = options.writes ?? new DefaultD1WriteCoordinator(db);
  }

  async claim(record: InboxRecord): Promise<InboxClaim> {
    const inserted = await this.#db
      .prepare(
        `INSERT INTO polybill_inbox (tenant_id, connection_id, environment, external_delivery_key, provider_event_id, received_at, verified_at, raw_body_digest, raw_body, verification_key_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing') ON CONFLICT DO NOTHING`,
      )
      .bind(
        record.tenantId,
        record.connection.id,
        record.connection.environment,
        record.deliveryKey,
        record.providerEventId ?? null,
        record.receivedAt,
        record.verified.verifiedAt,
        await digest(record.verified.rawBody),
        record.verified.rawBody,
        record.verified.keyId ?? null,
      )
      .run();
    if (inserted.meta?.changes === 1) return "claimed";
    const existing = await this.#db
      .prepare(
        "SELECT state FROM polybill_inbox WHERE tenant_id = ? AND connection_id = ? AND environment = ? AND external_delivery_key = ?",
      )
      .bind(
        record.tenantId,
        record.connection.id,
        record.connection.environment,
        record.deliveryKey,
      )
      .first<{ state: D1InboxRow["state"] }>();
    return existing?.state === "applied" ? "duplicate_applied" : "duplicate_processing";
  }

  async markApplied(record: InboxRecord, events: readonly CanonicalBillingEvent[]): Promise<void> {
    const outbox = events.map((event) =>
      this.#db
        .prepare(
          "INSERT INTO polybill_outbox (tenant_id, event_id, destination, payload, state, available_at) VALUES (?, ?, 'application', ?, 'pending', ?) ON CONFLICT(event_id, destination) DO NOTHING",
        )
        .bind(event.tenantId, event.id, JSON.stringify(event), event.observedAt),
    );
    const applied = this.#db
      .prepare(
        "UPDATE polybill_inbox SET state = 'applied', attempts = attempts + 1, last_error_code = NULL WHERE tenant_id = ? AND connection_id = ? AND environment = ? AND external_delivery_key = ?",
      )
      .bind(
        record.tenantId,
        record.connection.id,
        record.connection.environment,
        record.deliveryKey,
      );
    await this.#writes.execute([...outbox, applied], "webhook.mark_applied");
  }

  async markFailed(record: InboxRecord, errorCode: string, retryable: boolean): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE polybill_inbox SET state = ?, attempts = attempts + 1, last_error_code = ? WHERE tenant_id = ? AND connection_id = ? AND environment = ? AND external_delivery_key = ?",
      )
      .bind(
        retryable ? "retry_wait" : "dead_letter",
        errorCode,
        record.tenantId,
        record.connection.id,
        record.connection.environment,
        record.deliveryKey,
      )
      .run();
  }
}

async function digest(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
