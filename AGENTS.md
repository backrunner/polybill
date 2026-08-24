# Polybill Repository Instructions

## Scope and source of truth

These rules apply to the whole repository. Before implementing a feature, read the relevant design
documents in `.agents/`; begin with [.agents/README.md](.agents/README.md), then load the documents
for the affected domain. The project skill is
[.agents/skills/polybill-development/SKILL.md](.agents/skills/polybill-development/SKILL.md) and
should be used for Polybill implementation or review work.

The design documents are the current architecture contract, not aspirational marketing copy. If code
requires a different canonical field, state transition, capability, store invariant, webhook
behavior, runtime dependency, or migration guarantee, update the affected `.agents` document and add
a changeset or ADR note before changing the implementation.

## Architecture invariants

- Public APIs expose canonical Polybill entities and branded IDs. Provider IDs, raw statuses,
  payloads, and legal/MoR details stay in adapter snapshots, mappings, or evidence.
- Capabilities are explicitly `native`, `emulated`, or `unsupported`, with fidelity, limits, and
  migration behavior. An unsupported operation fails before an external request; an emulation
  returns its strategy and portability warning.
- Seller of record, tax/invoice, and dispute responsibility live in a dynamic commercial-terms
  snapshot. Never infer MoR from checkout support or silently route a MoR-required policy to a
  PSP/x402 connection.
- `Product`, `SKU`, and immutable `Price` remain separate. Catalog/order pricing crosses a public
  boundary as a validated decimal minor-unit string plus ISO-4217 currency; digital-asset atomic
  settlement and its quote are distinct types. Never silently treat USD as USDC or use floating
  point.
- Every tenant, connection, and environment is part of storage lookup and idempotency scope. Test
  and live credentials, external IDs, webhook secrets, mappings, and evidence cannot be mixed.
- A mutation claims idempotency before remote side effects. After a request may have been sent,
  recover by provider idempotency/read-back/reconciliation; never create a new key blindly after an
  unknown outcome.
- Webhooks verify the raw request bytes before parsing or side effects, persist an inbox record
  before ack, and canonicalize asynchronously. Duplicate, unknown, and out-of-order events must be
  safe.
- Provider webhook delivery is synchronization evidence, not automatic financial finality.
  High-value fulfillment needs an authoritative provider read or verified x402 receipt/chain
  finality according to policy.
- Polybill-owned licenses, entitlements, vouchers, and redemption ledger are portable truth.
  Provider-native license APIs may mirror them but cannot silently replace the local grant or
  redemption state.
- Migration is additive and reversible. Use `polybill_*` control-plane ports/tables and opaque host
  external IDs; do not take over host user/order tables or claim payment-token/subscription
  portability without a documented provider-assisted workflow.
- Core and default provider adapters target Cloudflare Workers: use Web APIs and injected ports; no
  `node:*`, filesystem, socket, process-global mutable state, or Node-only SDK in the default import
  graph. Node-specific helpers require an explicit `/node` subpath and bundle check.
- The v1 x402 adapter wraps `x402-paysdk` public merchant/receipt APIs. It represents one-time
  settlement; recurring payment requires a new customer authorization each cycle and must not be
  advertised as a mandate.

## TypeScript and code style

- Use strict TypeScript with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; run
  runtime validation at every external boundary. `unknown` is decoded before it becomes domain data;
  do not use `any`, unsafe non-null assertions, or a compiler-disable comment to bypass a provider
  mismatch.
- Prefer discriminated unions and exhaustive `never` checks. Keep one main concept per file, target
  less than 400 lines, and split or record an exception before a file exceeds 600 lines.
- Keep pure domain functions free of I/O. Application commands depend on ports; provider packages do
  not import stores or each other; the facade is the composition root. Avoid deep imports from
  public packages.
- Use structured error fields (`code`, `operation`, `provider`, `retryable`) and redact secrets,
  payment credentials, complete PII, raw signatures, and license plaintext from errors and logs.
- Prefer `apply_patch` for hand edits. Keep comments short and explain invariants or non-obvious
  decisions, not line-by-line narration. Preserve unrelated user changes in a dirty worktree.

## Testing and verification

Read [.agents/TESTING.md](.agents/TESTING.md) for the complete strategy. New behavior normally needs
a pure contract test plus the relevant adapter/store/webhook or migration fixture. Required tests
must not depend on public URLs, third-party accounts, or provider webhook delivery; use scripted
fetch, signed raw fixtures, virtual time, fake chain/provider, and reconciliation-first flows.

At minimum, run the checks relevant to the change, and before release run the full suite:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:workerd
pnpm test:migration
pnpm test:security
pnpm build
pnpm check:packages
pnpm check:worker-bundle
```

Do not hide a flaky or unavailable sandbox test behind retries. Mark an external compatibility job
as skipped when credentials are absent and keep the adapter at the documented maturity level.

## Git and commits

Use the repository-local identity for all commits:

```text
user.name=BackRunner
user.email=dev@backrunner.top
```

Commit subjects must match `xxx(comp): desc`, for example `feat(core): add money codec` or
`docs(agents): record provider capability gap`. Keep commits focused; do not mix generated lockfile
or format churn with an unrelated behavior change. Before committing, inspect `git diff` and
`git status`, run the appropriate checks, and include the resulting commit hash in the handoff.

## Change review checklist

Reviewers should ask:

1. Does the change preserve canonical semantics for all existing providers, or is the
   capability/loss report updated?
2. Are test/live, tenant, connection, idempotency, and raw evidence boundaries explicit in code and
   tests?
3. Can a timeout, duplicate, out-of-order event, queue retry, or missing webhook be recovered
   without a duplicate side effect?
4. Does the default Worker bundle remain Node-free and does the public type surface remain
   provider-neutral?
5. Does migration remain dry-runnable, resumable, auditable, and reversible without changing host
   schema?
