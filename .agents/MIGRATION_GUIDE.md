# Existing-System Migration Guide

Polybill uses an additive control plane. The host user/order schema remains the host's source of truth;
Polybill stores opaque external IDs, mappings, projections, inbox/outbox records and migration state in
`polybill_*` tables.

## Minimal integration

1. Create a `ProviderConnection` for the existing provider with an explicit environment.
2. Implement `ApplicationStore`/migration store ports or use `@polybill/store-d1`.
3. Attach the provider webhook to `/webhooks/polybill/:provider/:connection` in observe-only mode.
4. Run `analyze`, `plan` and `dryRun`; verify there are no target writes and review losses/blockers.
5. Consume canonical outbox events by event ID in the host application.
6. Start `shadow_read`, then cut over new sales by a persisted tenant/cohort routing decision.

## Existing host data

Use `HostIdentityBridge`, `HostOrderBridge` and `HostCatalogBridge` for host-specific lookup. Email or
name matching can produce a candidate but never silently merges customers. Historical import does not
emit live `payment.succeeded` or entitlement side effects unless a separate, explicit historical-event
policy is enabled.

## Active subscriptions and payment methods

Every active subscription is classified as one of `migrated`, `request_reauthorization`, `dual_run` or
`keep_source_pinned`. Payment tokens, mandates and wallet credentials stay at the provider. A provider-
assisted vault migration is recorded as evidence; Polybill never receives PAN/CVC or raw wallet tokens.

## Verification and cutback

`verify` reads the target by external ID and compares currency, amount, interval, tax behavior, status and
metadata links. Cutback returns new sales to the source routing mode without deleting target objects or
rewriting financial history. Resolve all blocking legal-responsibility, duplicate and unmapped conflicts
before entering `ready`.
