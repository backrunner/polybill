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

- Stripe discount create/read/redeem has an offline transport and amount read-back proof.
- Dodo and Polar canonical checkout discounts remain `unsupported` until external discount IDs and
  final net amount can be proven end to end.
- x402 is one-time USDC settlement. Recurring mandate is `unsupported`; any reauthorization workflow
  must create a new PaymentRef each period.
- Saved payment methods, card mandates and legal MoR responsibility are never marked portable merely
  because checkout creation works.

## Promotion checklist

Before changing an adapter to `preview` or `stable`, attach:

1. pinned provider API/schema version and source URL;
2. valid and negative webhook vectors, including key rotation and replay;
3. successful and failed mutation fixtures with idempotency/recovery;
4. reconciliation-first response-loss and missing-webhook scenarios;
5. Workerd bundle scan and published package provenance;
6. sandbox read-back evidence for every declared native capability;
7. documented rollback, support owner and provider drift date.
