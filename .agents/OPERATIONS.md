# Operations Runbook

## Webhook outage

1. Keep provider delivery enabled; do not acknowledge events that failed inbox persistence.
2. Inspect `polybill_inbox` by tenant, connection and environment. Retry `retry_wait`; review
   `dead_letter` with the provider delivery key and redacted error code.
3. Run provider reconciliation for payments/subscriptions before replaying fulfillment events.
4. Replay an inbox record only by its stored event ID/delivery key. The consumer and outbox are
   idempotent; never paste a provider payload into a new delivery key.

## Provider timeout or unknown checkout outcome

1. Keep the idempotency claim in `unknown` state.
2. Recover with the provider idempotency key or authoritative read/list endpoint.
3. Commit the canonical snapshot once; never retry with a newly generated key.
4. If the provider cannot read back the outcome, surface `outcome_unknown` and stop fulfillment.

## Queue and D1 pressure

- Queue consumers must ack only after inbox/outbox state is committed.
- Retry transient mapper/provider errors; dead-letter non-retryable schema or configuration errors.
- Keep voucher/license high-contention redemption behind the Durable Object coordinator or an
  equivalent serializing store primitive.
- D1 migrations run in order and are verified from both an empty database and the previous release.

## Secret rotation

- Add the new active webhook key while retaining the previous key for the documented provider window.
- Test and live key rings are separate resolver results.
- Remove the previous key only after delivery retry windows have elapsed; run a signed fixture before
  and after rotation.
- Never include full signatures, license plaintext, API keys or raw payment credentials in logs.

## Cutback

Cutback changes only new-sales routing. It does not delete target financial history or cancel already
created subscriptions. Keep source-pinned subscriptions on their source connection and reconcile both
connections until the migration report is closed.
