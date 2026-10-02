# Provider API and integration review — 2026-10-02

Scope: compare the implemented subscription lifecycle, transport version/authentication and webhook
translation against each provider's official API reference **and** integration guidance. This is
protocol review plus offline regression evidence, not authenticated sandbox certification. All
adapters remain experimental; the mechanism gaps in [SUBSCRIPTIONS_2026-10.md](./SUBSCRIPTIONS_2026-10.md)
remain open.

## Corrections required by the official contracts

1. **Dodo renewal failure:** `pending` means incomplete setup. `on_hold` is a recoverable collection
   failure on an existing subscription with automatic renewal stopped, so project it as canonical
   `unpaid`, preserving the raw status. `past_due` remains the distinct grace-period state. Observe
   `subscription.past_due`, `subscription.unpaused` and payment-method updates as synchronization
   evidence. No webhook grants payment finality or infers a trial end from elapsed calendar days.
2. **Creem expiry:** `subscription.expired` does **not** imply terminal cancellation. Payment retries
   can still succeed; only a confirmed `canceled` status is terminal. Emit `subscription.changed.v1`
   for expiry and recover the state through authoritative read-back. An expired event must not
   become a canonical canceled event merely because of its name.
3. **Lemon Squeezy cancellation:** `ends_at` is the authoritative expiration time; `renews_at` is a
   billing/retry timestamp. Preserve both independently: a pending cancel schedule uses `ends_at`,
   which the common projection uses for `accessUntil`. Never substitute `renews_at` for that cutoff
   when both are present.
4. **Waffo webhook identity:** subscription lifecycle events identify the subscription order with
   `data.orderId`. Their `eventId` may include a period or timestamp suffix and cannot be used as a
   subscription lookup ID. `subscription.payment_succeeded` remains a payment event identified by
   `eventId`. Observe renewal, recovery, cancellation withdrawal and plan-change events. A failed
   or scheduled plan change describes the **new** order; never guess its predecessor or cancel the
   still-active original subscription. An unmapped new order remains unmapped evidence.
5. **Polar revocation:** `subscription.revoked` also fires when collection retries end in `unpaid`.
   Emit a canonical canceled event only when the signed payload confirms `status: canceled` (or
   historical `revoked`); otherwise emit a changed event and retain the actual billing status.
   Access revocation and subscription cancellation are distinct facts.

These corrections require no schema migration. Existing incorrect local snapshots need a fresh
authoritative refresh; already-delivered canonical events cannot be retroactively withdrawn.
Polybill does not automatically erase terminal state or replay financial mutations to repair them.
Waffo keeps the existing scoped raw-body digest delivery key: its examples reuse resource `id` across
event types, and changing deduplication keys would require a separate inbox migration.

## Sources and per-provider review boundary

| Provider | Official API and integration evidence | Review conclusion / remaining boundary |
| --- | --- | --- |
| Stripe | [Basil SDK parameter contract](https://github.com/stripe/stripe-node/blob/v18.5.0/types/SubscriptionsResource.d.ts), [price changes](https://docs.stripe.com/billing/subscriptions/change-price), [collection pause](https://docs.stripe.com/billing/subscriptions/pause-payment), [full pause preview](https://docs.stripe.com/billing/subscriptions/pause), [webhooks](https://docs.stripe.com/webhooks) | Keep `2025-08-27.basil` pin, item pagination, explicit proration and cancellation clearing. Full billing pause is a separate flexible-billing preview contract; it is not implemented by `pause_collection`. Schedules and pending-payment workflows remain gaps. |
| Polar | [2026-10 schema](https://github.com/polarsource/polar/blob/main/docs/openapi/2026-10.openapi.json), [2027-01 schema](https://github.com/polarsource/polar/blob/main/docs/openapi/2027-01.openapi.json), [management](https://polar.sh/docs/features/subscriptions/manage.md), [proration](https://polar.sh/docs/features/subscriptions/proration.md), [revocation event](https://polar.sh/docs/api-reference/2027-01/subscription_revoked.md) | Fresh schema hashes match the reviewed baselines. Requests select one date; pending product/quantity changes remain separate from current items. Next fractional tiers remain raw evidence until a canonical fractional pricing contract exists. |
| Dodo | [SDK subscription contract](https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/subscriptions.ts), [integration](https://docs.dodopayments.com/developer-resources/subscription-integration-guide.md), [plan changes](https://docs.dodopayments.com/developer-resources/subscription-upgrade-downgrade.md), [subscription states](https://docs.dodopayments.com/features/subscription.md), [webhooks](https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription.md) | Status-only pause/resume requests, explicit `prevent_change`, preserved add-ons and scheduled read-back. An active trial need not have raw status `trialing`; `trial_period_days` is not an authoritative future trial-end timestamp. Grace-period access policy and payment-method recovery remain gaps. |
| Creem | [update](https://docs.creem.io/api-reference/endpoint/update-subscription.md), [pause](https://docs.creem.io/api-reference/endpoint/pause-subscription.md), [resume](https://docs.creem.io/api-reference/endpoint/resume-subscription.md), [integration and webhook lifecycle](https://docs.creem.io/code/webhooks.md) | Product reference and existing-item units stay distinct; all seven API status values are handled. Webhook expiry is nonterminal, despite its name. Multi-item/add-on replacement remains unsupported before writes. |
| Lemon Squeezy | [subscription object](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object), [update](https://docs.lemonsqueezy.com/api/subscriptions/update-subscription), [item update](https://docs.lemonsqueezy.com/api/subscription-items/update-subscription-item), [cancel](https://docs.lemonsqueezy.com/api/subscriptions/cancel-subscription), [integration](https://docs.lemonsqueezy.com/guides/developer-guide/managing-subscriptions) | JSON:API variant and quantity updates use distinct endpoints. PayPal requires customer authorization; successful no-op PATCH cannot establish success. Cancellation grace uses `ends_at`. Metered items need usage records. |
| Paddle | [update](https://developer.paddle.com/api-reference/subscriptions/update-subscription.md), [pause](https://developer.paddle.com/api-reference/subscriptions/pause-subscription.md), [resume](https://developer.paddle.com/api-reference/subscriptions/resume-subscription.md), [item-change integration](https://developer.paddle.com/build/subscriptions/add-remove-products-prices-addons.md), [webhooks](https://developer.paddle.com/webhooks/) | Full desired item list with explicit proration; scheduled pause/resume fields retained. Resume now explicitly selects continue-current or restart; omitting the policy keeps the previous restart behavior. Continue-current requires an unexpired paused period. Optional host-driven future item execution does not guarantee invoice-time semantics. |
| Waffo Pancake | [authentication](https://docs.waffo.ai/api-reference/authentication.md), [subscriptions guide](https://docs.waffo.ai/guides/subscriptions.md), [merchant cancel](https://docs.waffo.ai/api-reference/endpoints/subscriptions/cancel-subscription.md), [customer reactivation](https://docs.waffo.ai/api-reference/endpoints/subscriptions/reactivate-order.md), [GraphQL read-back](https://docs.waffo.ai/api-reference/endpoints/graphql/orders-and-payments.md), [webhooks](https://docs.waffo.ai/api-reference/webhooks.md) | Request signatures use seconds; webhook signature timestamps use milliseconds and a 45-minute retry window. Keys bind environments. Merchant cancel and customer-session reactivation are different auth flows. Canonical customer/product bindings and subscription command ports remain gaps. |
| x402 | Installed `x402-paysdk@0.1.0` public `merchant` exports, declarations and README; [official integration site](https://x402.pwp.sh), [source repository](https://github.com/backrunner/x402-paysdk) | Public merchant client/receipt verification are the versioned contract. One-time settlement does not supply recurring authorization. Every billing cycle requires a new payer authorization; a recurring workflow is not implemented. |

Only Stripe/Polar/Paddle negotiate their listed API versions over HTTP. Other adapter version strings
are review labels or SDK references, not a server compatibility guarantee. A transmitted idempotency
header alone is not proof of provider support; local durable claims and unknown-outcome recovery
remain mandatory.

The x402 documentation site was inaccessible from both HTTP and the browser search tool during this
review. Its evidence above is the installed, pinned public package contract; a fresh hosted guide
comparison remains unverified. Dodo's `past_due_ends_at` is webhook-only according to its guide, so
polling the subscription API alone cannot reconstruct that deadline.

## Validation evidence

- Initial official-contract review: 55 test files / 348 tests passed, including 25 added regression cases. Coverage
  includes raw signed lifecycle events, exact nonterminal event assertions, Waffo order/payment
  identity separation and unknown-order handling, all documented Dodo statuses, and Lemon's cutoff
  through the canonical store projection.
- Full build and workspace typecheck, lint, formatting, `git diff --check`, package lint and Worker
  import scan pass. Package lint retains the existing example-worker packaging suggestion.
- The later billing-workflow extension adds mapped-customer checkout binding, local schedules and
  credits, native Stripe/Dodo/Polar meters, and explicit Paddle resume policy. Polar event recovery
  uses a reserved metadata marker because its read schema omits ingestion's external ID. Its expanded
  baselines cover 294 reviewed entries for `2026-10` and 290 for `2027-01`.
  No provider account mutation, authenticated sandbox run or webhook endpoint upgrade was performed.
- Billing-workflow continuation checkpoint: 61 test files / 404 tests pass, including interrupted
  schedule creation, competing executors, rejected-schedule reconciliation, concurrent credit debits,
  D1 insert-only binding recovery and exact Polar event read-back. Full workspace build/typecheck,
  lint, formatting, package lint and Worker import scan pass. Both expanded Polar schema checks match.

## 中文复核结论

本轮发现了续费欠费误判、非终态事件误判为取消、取消截止时间取错，以及 Waffo 事件关联 ID
取错等实际协议偏差。修复必须配套官方语义的离线回归场景，不能只验证 HTTP 返回成功。
后续已补上本地 schedule/credits、三家的用量接口和五家的已映射客户异步开通绑定；原生
schedule、计量价格目录、完整客户授权和 Waffo 完整读写仍需继续。文档核对和本地测试通过
不等于各家真实 sandbox 验收通过，当前覆盖以 SUBSCRIPTIONS_2026-10.md 为准。
