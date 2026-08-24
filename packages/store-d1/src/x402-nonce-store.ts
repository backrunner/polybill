import type { D1DatabaseLike } from "./d1.js";

export interface D1X402NonceStoreOptions {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly nowSeconds?: () => number;
}

export class D1X402NonceStore {
  readonly #db: D1DatabaseLike;
  readonly #options: D1X402NonceStoreOptions;

  constructor(db: D1DatabaseLike, options: D1X402NonceStoreOptions) {
    this.#db = db;
    this.#options = options;
  }

  async putIfAbsent(key: string, expiresAtSeconds: number): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `INSERT INTO polybill_x402_notify_nonces (tenant_id, connection_id, nonce_key, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, connection_id, nonce_key) DO UPDATE SET expires_at = excluded.expires_at WHERE polybill_x402_notify_nonces.expires_at <= ?`,
      )
      .bind(
        this.#options.tenantId,
        this.#options.connectionId,
        key,
        expiresAtSeconds,
        (this.#options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
      )
      .run();
    return result.meta?.changes === 1;
  }
}

export class D1X402TransactionStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async claim(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly txHash: string;
    readonly orderId: string;
    readonly paymentId: string;
    readonly observedAt: string;
  }): Promise<"claimed" | "replay" | "conflict"> {
    const result = await this.#db
      .prepare(
        "INSERT INTO polybill_x402_transactions (tenant_id, connection_id, tx_hash, order_id, payment_id, observed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, connection_id, tx_hash) DO NOTHING",
      )
      .bind(
        input.tenantId,
        input.connectionId,
        input.txHash,
        input.orderId,
        input.paymentId,
        input.observedAt,
      )
      .run();
    if (result.meta?.changes === 1) return "claimed";
    const existing = await this.#db
      .prepare(
        "SELECT order_id, payment_id FROM polybill_x402_transactions WHERE tenant_id = ? AND connection_id = ? AND tx_hash = ?",
      )
      .bind(input.tenantId, input.connectionId, input.txHash)
      .first<{ order_id: string; payment_id: string }>();
    return existing?.order_id === input.orderId && existing.payment_id === input.paymentId
      ? "replay"
      : "conflict";
  }
}
