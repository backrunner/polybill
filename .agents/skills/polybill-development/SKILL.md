---
name: polybill-development
description: "Develop or review Polybill TypeScript changes that touch the canonical billing domain, provider adapters, webhooks, migrations, x402 payments, or Cloudflare deployment."
---

# Polybill Development Rules

Use this skill for implementation and review work in Polybill. Read the relevant
documents in `.agents/` before editing code; `.agents/README.md` is the routing
index. Read `.agents/ARCHITECTURE.md`, `.agents/DATA_MODEL.md`, and
`.agents/TESTING.md` for cross-cutting changes.

## Non-negotiable invariants

- The canonical domain model is provider-neutral. Provider IDs, statuses, and
  webhook payloads stay behind an adapter; never expose them as the primary
  public API.
- Declare each provider capability as `native`, `emulated`, or `unsupported`.
  Never silently drop fields, change billing semantics, or pretend payment
  methods can migrate.
- Keep seller-of-record, tax invoice, and dispute responsibility explicit.
  A successful checkout capability does not make a PSP or settlement network a
  merchant of record; block incompatible commercial policy before transport.
- Keep `test` and `live` credentials, object IDs, webhook secrets, and mappings
  isolated. Every command receives an explicit environment.
- Represent catalog/order pricing as integer minor units plus an ISO-4217
  currency. Keep digital-asset atomic amounts and settlement quotes as distinct
  types; never silently treat USD as USDC or use floating point.
- Verify webhook signatures over raw request bytes before parsing JSON;
  deduplicate by connection and provider delivery ID (or the documented raw
  digest fallback) before side effects.
- Treat webhook delivery as a synchronization hint, not financial finality.
  Confirm payment through the provider API, receipt, or x402 chain verification.
- Keep core Cloudflare-safe: use `fetch`, Web Crypto, timers, and injected ports.
  Do not import `node:*`, filesystem APIs, sockets, or process-global mutable
  state from core or edge adapters.
- Wrap the existing `x402-paysdk` merchant and receipt helpers. x402 is a
  one-time crypto settlement path in v1; do not claim recurring authorization.
- License keys and redemption are Polybill-owned entitlements. Store a keyed
  digest for lookup, encrypt recoverable secrets, redeem atomically, and never
  log plaintext keys.
- Migration is additive and reversible. Prefer `polybill_*` control-plane
  tables, external-ID mappings, shadow imports, and an outbox over taking over
  application order or user tables.

## Implementation workflow

1. Identify the affected domain contract and provider capability in the design
   docs; update the document first when behavior changes.
2. Add or update a pure domain function and its contract tests.
3. Implement adapter translation, preserving raw IDs and raw event evidence for
   reconciliation.
4. Add webhook vectors for signature, replay, duplicate, out-of-order, and
   unknown-event behavior.
5. Run typecheck, lint, unit/contract tests, and the relevant Cloudflare bundle
   check. Integration tests use fake provider servers by default; live
   credentials are opt-in and never required for CI.

## Public API and errors

- Use branded IDs and discriminated unions for statuses and capability results.
- Return errors with a stable `code`, `operation`, `provider`, and `retryable`
  flag. Preserve only a redacted provider error for diagnostics.
- Expose `getCapabilities()` and an `UnsupportedCapability` error instead of a
  provider-specific runtime surprise.
- Every mutation accepts an idempotency key or receives one from the command
  layer; retries must be safe.

## Git

Commit as `BackRunner <dev@backrunner.top>` with `xxx(comp): desc`, for example
`feat(core): add canonical subscription contract` or
`docs(agents): record provider capability gaps`.
