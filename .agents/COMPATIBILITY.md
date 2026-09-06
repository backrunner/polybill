# Compatibility Matrix

状态：offline release evidence，2026-08-25。没有第三方凭据的环境不会伪造 sandbox 结果。

## Evidence levels

| Level | Meaning | Release use |
| --- | --- | --- |
| `offline` | scripted transport、known signature、runtime codec、reconcile fixture | CI required |
| `workerd` | Miniflare/workerd Worker bundle、D1、Queue 或 DO | CI required for edge path |
| `sandbox` | provider-owned test account and read-back | manual/nightly; required before stable |
| `production` | controlled beta observation and rollback evidence | stable release evidence |

## Adapter status

| Adapter | Descriptor | Offline contract | Workerd import | Sandbox evidence in this repo | Known blockers |
| --- | --- | --- | --- | --- | --- |
| Stripe | experimental | present | present | not recorded | real test account, test clock and API drift run |
| Dodo Payments | experimental | present | present | not recorded | subscription/discount semantics and real MoR verification |
| Polar | experimental | present | present | not recorded | discount and subscription create semantics |
| Creem | experimental | present | present | not recorded | refund read-back and active subscription migration |
| Waffo Pancake | experimental | present | present | not recorded | API/product line stability, KYB and subscription migration |
| Lemon Squeezy | experimental | present | present | not recorded | catalog/license API drift and active subscription workflow |
| Paddle Billing | experimental | present | present | not recorded | Billing-only sandbox verification and simulator replay |
| x402 | experimental | present | present | local fake gateway only | published tarball compatibility, chain/gateway test network |

## Capability policy

- [2026-09-06 payment review](./PAYMENT_REVIEW_2026-09-06.md) records the latest source review and
  corrected failure paths. Polar multi-item checkout is unsupported because its products are
  alternatives, not cart lines. Dodo, Polar and Creem checkout POST replay is not advertised as
  recovery. Stripe replay is limited to a persisted attempt younger than 23 hours.
- Checkout completion alone never marks a Payment succeeded. Standalone payment/receipt evidence
  remains necessary, including when checkout read-back reports complete.
- Host stores must implement immutable `bindConnection` and inbox `markQueued`; apply D1 migration
  `0011_inbox_dispatch.sql` before deploying this version. Register existing connection identities
  before allowing commands against pre-upgrade mappings.

- Stripe discount create/read/redeem has an offline transport and amount read-back proof.
- Dodo and Polar canonical checkout discounts remain `unsupported` until external discount IDs and
  final net amount can be proven end to end.
- Dodo, Polar, Creem, Lemon Squeezy, and Paddle Billing direct `subscription.create` remain
  `unsupported`. Their documented recurring flows create the subscription after a hosted checkout
  or paid transaction. Dodo's deprecated direct endpoint additionally requires a billing address,
  which is outside the canonical command. A future capability requires an explicit asynchronous
  checkout-to-subscription workflow, provider read-back, and response-loss reconciliation proof.
- x402 is one-time USDC settlement. Recurring mandate is `unsupported`; any reauthorization workflow
  must create a new PaymentRef each period.
- Saved payment methods, card mandates and legal MoR responsibility are never marked portable merely
  because checkout creation works.
- Refund projections are ledger-based: a provider response must match the requested currency and
  amount and cannot increase the canonical refunded balance beyond the payment. Paddle Billing
  supports full refunds only; `refund.partial` is explicitly `unsupported` and is rejected before
  transport.
- Stripe payment-intent processing, action-required, canceled, and failed events are mapped to
  explicit payment lifecycle events. Stripe dispute events remain `unmapped_provider_event.v1`
  because the canonical Dispute aggregate and store contract are not yet implemented; they are
  retained as verified inbox/audit evidence and never silently treated as refunds or failures.
- Waffo checkout has no authoritative session read-back. Its adapter therefore does not advertise
  idempotency-key recovery; an outcome-unknown result remains unknown until an external/provider
  reconciliation workflow can establish the session.

## Promotion checklist

Before changing an adapter to `preview` or `stable`, attach:

1. pinned provider API/schema version and source URL;
2. valid and negative webhook vectors, including key rotation and replay;
3. successful and failed mutation fixtures with idempotency/recovery;
4. reconciliation-first response-loss and missing-webhook scenarios;
5. Workerd bundle scan and published package provenance;
6. sandbox read-back evidence for every declared native capability;
7. documented rollback, support owner and provider drift date.
