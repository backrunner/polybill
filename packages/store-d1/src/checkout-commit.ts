import type { CheckoutCommit } from "@polybill/application";
import type { TenantId } from "@polybill/core";
import type { D1DatabaseLike, D1Result } from "./d1.js";
import { createD1PersistenceAdapter, type D1PersistenceWriter } from "./persistence-adapter.js";

export interface CheckoutCommitOptions {
  readonly writes?: D1PersistenceWriter;
}

export async function commitCheckoutToD1(
  db: D1DatabaseLike,
  commit: CheckoutCommit,
  options: CheckoutCommitOptions = {},
): Promise<void> {
  const writes = options.writes ?? createD1PersistenceAdapter(db);
  const existing = await checkoutCommitState(db, commit);
  if (existing === "same") return;
  if (existing === "conflict")
    throw new Error("Checkout already exists with different canonical data");
  try {
    const results = await writes.execute(
      commit.discountReservationId === undefined
        ? standardStatements(db, commit)
        : discountedStatements(db, commit),
      "checkout.commit",
    );
    if (
      commit.discountReservationId !== undefined &&
      results.some((result) => changes(result) !== 1)
    )
      throw new Error("Discounted checkout commit was not atomic");
  } catch (error) {
    if ((await checkoutCommitState(db, commit)) === "same") return;
    throw error;
  }
}

function standardStatements(db: D1DatabaseLike, commit: CheckoutCommit) {
  return [
    db
      .prepare(
        "INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, 'checkout', ?, ?, 1, 'created') ON CONFLICT(tenant_id, connection_id, entity_type, entity_id) DO NOTHING",
      )
      .bind(commit.tenantId, commit.connectionId, commit.checkout.id, commit.externalCheckoutId),
    snapshotStatement(db, commit, "checkout", commit.checkout.id, commit.checkout),
    snapshotStatement(db, commit, "order", commit.order.id, commit.order),
    snapshotStatement(db, commit, "payment", commit.payment.id, commit.payment),
    ...(commit.externalPaymentId === undefined ? [] : [paymentMappingStatement(db, commit)]),
    auditStatement(db, commit),
  ];
}

function discountedStatements(db: D1DatabaseLike, commit: CheckoutCommit) {
  const reservationId = commit.discountReservationId;
  if (reservationId === undefined) throw new Error("Discount reservation is required");
  const discount = commit.order.discounts[0];
  if (commit.order.discounts.length !== 1 || discount === undefined)
    throw new Error("Discounted checkout must contain exactly one discount snapshot");
  const guard =
    "EXISTS (SELECT 1 FROM polybill_discount_redemptions WHERE tenant_id = ? AND redemption_id = ? AND status = 'finalized' AND order_id = ?)";
  return [
    db
      .prepare(
        "UPDATE polybill_discount_redemptions SET status = 'finalized', finalized_at = ?, order_id = ? WHERE tenant_id = ? AND connection_id = ? AND redemption_id = ? AND discount_id = ? AND status = 'reserved'",
      )
      .bind(
        commit.occurredAt,
        commit.order.id,
        commit.tenantId,
        commit.connectionId,
        reservationId,
        discount.discountId,
      ),
    db
      .prepare(
        `INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) SELECT ?, ?, 'checkout', ?, ?, 1, 'created' WHERE ${guard}`,
      )
      .bind(
        commit.tenantId,
        commit.connectionId,
        commit.checkout.id,
        commit.externalCheckoutId,
        commit.tenantId,
        reservationId,
        commit.order.id,
      ),
    guardedSnapshot(db, commit, "checkout", commit.checkout.id, commit.checkout, reservationId),
    guardedSnapshot(db, commit, "order", commit.order.id, commit.order, reservationId),
    guardedSnapshot(db, commit, "payment", commit.payment.id, commit.payment, reservationId),
    ...(commit.externalPaymentId === undefined
      ? []
      : [guardedPaymentMappingStatement(db, commit, reservationId)]),
    db
      .prepare(
        `INSERT INTO polybill_audit (tenant_id, operation, evidence, occurred_at) SELECT ?, 'checkout.commit', ?, ? WHERE ${guard}`,
      )
      .bind(
        commit.tenantId,
        auditEvidence(commit),
        commit.occurredAt,
        commit.tenantId,
        reservationId,
        commit.order.id,
      ),
  ];
}

function paymentMappingStatement(db: D1DatabaseLike, commit: CheckoutCommit) {
  return db
    .prepare(
      "INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, 'payment', ?, ?, 1, 'created') ON CONFLICT(tenant_id, connection_id, entity_type, entity_id) DO NOTHING",
    )
    .bind(commit.tenantId, commit.connectionId, commit.payment.id, commit.externalPaymentId);
}

function guardedPaymentMappingStatement(
  db: D1DatabaseLike,
  commit: CheckoutCommit,
  reservationId: string,
) {
  const guard =
    "EXISTS (SELECT 1 FROM polybill_discount_redemptions WHERE tenant_id = ? AND redemption_id = ? AND status = 'finalized' AND order_id = ?)";
  return db
    .prepare(
      `INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) SELECT ?, ?, 'payment', ?, ?, 1, 'created' WHERE ${guard}`,
    )
    .bind(
      commit.tenantId,
      commit.connectionId,
      commit.payment.id,
      commit.externalPaymentId,
      commit.tenantId,
      reservationId,
      commit.order.id,
    );
}

function snapshotStatement(
  db: D1DatabaseLike,
  commit: CheckoutCommit,
  type: string,
  id: string,
  value: unknown,
) {
  return db
    .prepare(
      "INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(tenant_id, aggregate_type, aggregate_id) DO NOTHING",
    )
    .bind(commit.tenantId, type, id, commit.occurredAt, JSON.stringify(value));
}

function guardedSnapshot(
  db: D1DatabaseLike,
  commit: CheckoutCommit,
  type: string,
  id: string,
  value: unknown,
  reservationId: string,
) {
  return db
    .prepare(
      `INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) SELECT ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM polybill_discount_redemptions WHERE tenant_id = ? AND redemption_id = ? AND status = 'finalized' AND order_id = ?)`,
    )
    .bind(
      commit.tenantId,
      type,
      id,
      commit.occurredAt,
      JSON.stringify(value),
      commit.tenantId,
      reservationId,
      commit.order.id,
    );
}

function auditStatement(db: D1DatabaseLike, commit: CheckoutCommit) {
  return db
    .prepare(
      "INSERT INTO polybill_audit (tenant_id, operation, evidence, occurred_at) VALUES (?, 'checkout.commit', ?, ?)",
    )
    .bind(commit.tenantId, auditEvidence(commit), commit.occurredAt);
}

function auditEvidence(commit: CheckoutCommit): string {
  return JSON.stringify({
    evidenceId: commit.evidenceId,
    provider: commit.provider,
    value: commit.evidence,
  });
}

async function checkoutCommitState(
  db: D1DatabaseLike,
  commit: CheckoutCommit,
): Promise<"empty" | "same" | "conflict"> {
  const [mapping, paymentMapping, checkout, order, payment, reservation] = await Promise.all([
    db
      .prepare(
        "SELECT external_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type = 'checkout' AND entity_id = ?",
      )
      .bind(commit.tenantId, commit.connectionId, commit.checkout.id)
      .first<{ external_id: string }>(),
    commit.externalPaymentId === undefined
      ? Promise.resolve(null)
      : db
          .prepare(
            "SELECT external_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type = 'payment' AND entity_id = ?",
          )
          .bind(commit.tenantId, commit.connectionId, commit.payment.id)
          .first<{ external_id: string }>(),
    snapshot(db, commit.tenantId, "checkout", commit.checkout.id),
    snapshot(db, commit.tenantId, "order", commit.order.id),
    snapshot(db, commit.tenantId, "payment", commit.payment.id),
    commit.discountReservationId === undefined
      ? Promise.resolve(null)
      : db
          .prepare(
            "SELECT status, order_id FROM polybill_discount_redemptions WHERE tenant_id = ? AND redemption_id = ?",
          )
          .bind(commit.tenantId, commit.discountReservationId)
          .first<{ status: string; order_id: string | null }>(),
  ]);
  if (
    mapping === null &&
    paymentMapping === null &&
    checkout === null &&
    order === null &&
    payment === null
  )
    return reservation?.status === "finalized" ? "conflict" : "empty";
  const reservationMatches =
    commit.discountReservationId === undefined ||
    (reservation?.status === "finalized" &&
      reservation.order_id === commit.order.id &&
      commit.order.discounts.length === 1);
  return mapping?.external_id === commit.externalCheckoutId &&
    (commit.externalPaymentId === undefined ||
      paymentMapping?.external_id === commit.externalPaymentId) &&
    checkout === JSON.stringify(commit.checkout) &&
    order === JSON.stringify(commit.order) &&
    payment === JSON.stringify(commit.payment) &&
    reservationMatches
    ? "same"
    : "conflict";
}

async function snapshot(
  db: D1DatabaseLike,
  tenantId: TenantId,
  type: string,
  id: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT snapshot FROM polybill_snapshots WHERE tenant_id = ? AND aggregate_type = ? AND aggregate_id = ?",
    )
    .bind(tenantId, type, id)
    .first<{ snapshot: string }>();
  return row?.snapshot ?? null;
}

function changes(result: D1Result): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}
