# Subscription compatibility contract

Reviewed 2026-10-02. Covers all eight adapters and explicit Polar 2027-01 opt-in. Provider support
does not imply payment-token portability or sandbox evidence.

The [official API and integration review](./PROVIDER_API_REVIEW_2026-10-02.md) defines the subsequent
Dodo unpaid-state, Creem nonterminal expiry, Lemon cancellation-date and Waffo event-identity fixes.

## Canonical semantics

- Current items come from authoritative snapshots, never from an unapplied requested change.
  Scheduled changes carry kind, effective time and, when provided, future items.
- `collectionPause` describes invoice handling without changing subscription status. Stripe
  `pause_collection` does not imply `status: paused`; `unpaid` remains unpaid rather than canceled.
- `trialEnd` and `resumesAt` are optional observed timestamps. Pause policies accept an optional
  automatic resume time. Unknown statuses and invalid quantities cannot become valid domain data.
- `clearScheduledChange(kind)` reverses a pending cancel/pause/items change and is distinct from
  resuming an already paused subscription. `setTrialEnd` takes a future timestamp or `now`.
- Resume may explicitly choose `billingPeriod: continue_current | restart` through a separate
  policy-aware port. Paddle implements both; other adapters reject an explicit policy before
  transport until reviewed. Omitting the policy preserves the adapter's documented legacy behavior.
- Direct synchronous creation remains separate from customer-authorized recurring checkout.
  Checkout does not immediately produce an active subscription. x402 has no recurring mandate.
- Every operation exposes exact timing, proration and provider limits; unsupported combinations fail
  before mutation. Response loss and failed read-back remain unknown, with no blind POST retry.
- New optional fields use existing JSON resource snapshots; old records remain readable and no host
  schema or destructive migration is required.

## Polar versions

`createPolarAdapter({ apiVersion: "2027-01" })` explicitly selects the reviewed Next contract.
Default `2026-10` remains stable. Each adapter owns its transport pin without global mutable state;
all requests and capability reports agree. Webhooks decode 2026-04, 2026-10 and 2027-01 independently
of HTTP selection, retaining historical redelivery. Unknown versions remain unmapped evidence.
Next seat prices use `tiers`, decimal-string `unit_amount`, and separate quantity bounds. Fractional
minor-unit rates must not be coerced into integer Money. Maintain separate reviewed schema baselines
for each supported version; adopting Next does not authorize following future schema changes.

## Implementation coverage

This matrix describes the implemented adapter, not the complete provider product. `GAP` means work
still required in Polybill. A provider limitation and an adapter gap are not interchangeable.
All subscription and usage capability keys now return an explicit result, including unimplemented
operations. Maturity remains experimental and authenticated sandbox evidence is absent.

| Adapter | Plan / quantity | Pause / resume | Reverse scheduled change | Trial end | Remaining mechanisms |
| --- | --- | --- | --- | --- | --- |
| Stripe | Immediate, multi-item, three proration modes | Collection pause plus real paused-subscription resume; automatic collection resume | Cancel | Future / now; direct-create day/week trial <=730 days | Checkout binding and meter ingestion implemented. GAP: native schedule phases, mixed-interval creation, metered price binding and pending-payment recovery |
| Polar 2026-10 / 2027-01 | Single product; separate product and seat/unit changes; immediate proration or next-period no-proration | Period-end stop billing; automatic resume | Cancel / pause / items | Future / now | Checkout binding, meter ingestion and scoped event read-back implemented. GAP: fractional tier catalog integration and metered price binding |
| Dodo | Single product, preserve add-ons; immediate or next billing date; explicit prevent-change on failed payment | Immediate stop billing, manual resume | Cancel / items | No reviewed trial-end update endpoint | Checkout binding, meter ingestion and event read-back implemented. GAP: add-on lifecycle, metered price binding and provider credits |
| Creem | Immediate existing-item quantity or product upgrade; separate operations | Immediate stop billing, manual resume | Cancel | Product configuration only | Checkout binding implemented. GAP: add-on lifecycle and provider meters/credits |
| Lemon Squeezy | Immediate variant or subscription-item quantity; separate operations | Immediate void/free collection pause, optional automatic resume | Cancel | Future / now | GAP: usage records and PayPal customer-authorization workflow; no merchant API immediate cancellation |
| Paddle | Immediate multi-item, three proration modes | Immediate/period-end stop billing, automatic resume; explicit continue-current or restart billing-period policy | Cancel / pause | Future >=30 minutes / activate automatic-collection trial now | Checkout binding and opt-in local deferred workflow implemented. GAP: invoice-time/anchor guarantees and payment recovery |
| Waffo | GAP | GAP | GAP: customer session authorization required | GAP | Hosted recurring checkout and lifecycle event mapping exist; merchant read/cancel, authorization and complete canonical bindings are not implemented |
| x402 | No provider subscription engine | No provider subscription engine | No provider subscription engine | No provider subscription engine | Each cycle requires a new authorization; a Polybill recurring reauthorization workflow is not implemented |

Read-back updates current and scheduled items through scoped reverse mappings. An unconfirmed
immediate or scheduled item change produces an unknown outcome and cannot be replayed as another
mutation. Date validation occurs inside a claimed command so a completed idempotent replay remains
valid after its original future timestamp passes. Stripe Basil periods are read from subscription
items only when all items share the same boundary; differing periods are not collapsed into one.
Independent item periods are retained in canonical snapshots. With `billing.store`, local multi-phase
scheduling and an exact credit ledger are available; local scheduling requires a host executor and
does not promise native invoice-time semantics. See [billing workflows](./BILLING_WORKFLOWS.md).

## Review invariants

Reconciliation uses the same validated snapshot projection as refresh, including removal of optional
schedule, collection-pause, trial and resume fields. Foreign subscription/customer IDs and unmapped
prices fail closed; provider IDs never become canonical price IDs. Preflight reads must match the
requested subscription before their item IDs or policy state can authorize a mutation.

Stripe subscription item lists are paginated before replacement or projection. Pagination is bounded
and rejects duplicate or foreign items. Creem's mapped price reference is its product ID, consistently
with checkout and upgrade; raw `price_id` does not override `product_id`. Multi-item Creem replacement
requires a future explicit add-on contract and is rejected before either quantity or product changes.
Paddle scheduled pause/resume timestamps must survive snapshot projection and reconciliation.
Scheduled cancellations expose `accessUntil` at their authoritative cancellation time, including
Stripe's explicit `cancel_at`; clearing cancellation removes both the schedule and access cutoff.
An already-applied replacement does not confirm a requested period-end change unless it was already
the canonical current plan and no conflicting item schedule remains.

## End-to-end review invariants

- Refresh and mutation snapshots replace an existing subscription only at the version read before
  the provider request. Losing a race requires a fresh authoritative read; no mutation is replayed.
- Reconciliation checkpoints are isolated by mode and stream. Reaching an empty terminal page clears
  the cursor so the next call scans again; sequence numbers remain monotonic. Child command keys
  include stream, mode, sequence and target and are hashed to a bounded size.
- Cancellation, pause/resume, schedule reversal and trial changes require a matching observed
  postcondition. A successful HTTP response with unchanged or contradictory state is an unknown
  outcome and never a completed command.
- The existing terminal canceled-state invariant also applies at the application snapshot boundary:
  a later stale read cannot revive it. Invalid status/date/pause/schedule data never reaches storage.

## Completion work still required

The request to support every subscription mechanism is **not complete** merely because common
lifecycle ports and capability reporting pass. Remaining work must include:

1. Extend the five-provider mapped-customer checkout binding to anonymous/customer authorization,
   first charge, renewal and dunning recovery. The current binding can poll without a webhook and
   distinguishes failed/expired checkout, but does not establish financial finality.
2. Native Stripe schedule phases and complete discounts/taxes/anchor preservation. The durable local
   multi-phase executor and read-back recovery are implemented; they do not provide native timing.
3. Extend the typed local credit ledger, meter mappings, ingest idempotency and fractional rounding
   into metered price catalog/invoice integration, provider wallets and remaining provider usage APIs.
   Stripe unknown event outcomes still require external reconciliation. Polar and Dodo can recover
   by exact event read-back without another ingestion request.
4. Waffo merchant GraphQL schema evidence for canonical customer/product bindings and a distinct
   customer-session workflow for reactivation. Do not guess GraphQL fields from REST SDK types.
5. Add-on, multi-price, mixed-interval, billing-anchor and payment-method recovery workflows; real
   provider sandbox checks for each advertised operation before maturity promotion.

## 中文

已补齐这次实现范围内的套餐/数量变更、暂停与恢复、取消撤销、试用结束日期和生命周期事件。
周期末变更以远端已确认的计划为准，不提前替换当前套餐；Stripe 暂停收款不改成订阅暂停。
2027-01 已可显式启用，并保留新阶梯价格的小数字符串精度。

“所有平台的所有订阅机制”仍未全部完成。上表中的 GAP 是 Polybill 的待接入功能，不代表平台
没有该能力。已新增五家的已映射客户订阅绑定、本地多阶段排程与额度账本，以及 Stripe、Polar、
Dodo 的 meter/usage 接口。仍需补齐匿名开通、原生 schedule、混合周期创建、计量价格绑定、
provider credits、附加项及 Waffo/PayPal 客户授权。`unsupported` 只是报告缺口，不是完成适配。

## Official sources and constraints

- [Polar management](https://polar.sh/docs/features/subscriptions/manage.md),
  [proration](https://polar.sh/docs/features/subscriptions/proration.md),
  [2027-01 schema](https://github.com/polarsource/polar/blob/main/docs/openapi/2027-01.openapi.json).
- [Stripe update](https://docs.stripe.com/api/subscriptions/update),
  [resume](https://docs.stripe.com/api/subscriptions/resume),
  [collection pause](https://docs.stripe.com/billing/subscriptions/pause-payment).
- [Dodo plan change](https://docs.dodopayments.com/api-reference/subscriptions/change-plan),
  [SDK contract](https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/subscriptions.ts).
- [Creem update](https://docs.creem.io/api-reference/endpoint/update-subscription),
  [upgrade](https://docs.creem.io/api-reference/endpoint/upgrade-subscription),
  [resume](https://docs.creem.io/api-reference/endpoint/resume-subscription).
- [Lemon update](https://docs.lemonsqueezy.com/api/subscriptions/update-subscription),
  [quantity](https://docs.lemonsqueezy.com/api/subscription-items/update-subscription-item).
  PayPal changes require the returned customer portal URL, not a successful server-side no-op.
- [Paddle update](https://developer.paddle.com/api-reference/subscriptions/update-subscription),
  [pause](https://developer.paddle.com/api-reference/subscriptions/pause-subscription).
- [Waffo cancel](https://docs.waffo.ai/api-reference/endpoints/subscriptions/cancel-subscription.md),
  [reactivate](https://docs.waffo.ai/api-reference/endpoints/subscriptions/reactivate-order.md),
  [read-back](https://docs.waffo.ai/api-reference/endpoints/graphql/orders-and-payments.md).
  Waffo reactivation requires customer session-token auth, not merchant API-key auth. Cancellation
  timing is status-dependent: active ends at period end, pending/past-due cancel immediately.
