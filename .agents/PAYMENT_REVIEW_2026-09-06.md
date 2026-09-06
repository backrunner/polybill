# Payment integration review — 2026-09-06

This review uses the publicly served provider documentation and official SDK sources retrieved on
2026-09-06. Offline checks establish protocol and failure-path behavior; they do not establish
account-specific sandbox compatibility. All adapters remain experimental.

## Contract corrections

- A completed checkout is not payment evidence. Both catalog and ad hoc checkout creation preserve
  a pending Payment until a separate authoritative payment/receipt reconciliation establishes
  success. Stripe explicitly permits a complete session whose payment is still processing.
- Once transport may have sent a mutation, response decoding, body streaming, and local persistence
  failures retain the idempotency claim. A subsequent explicit rejection cannot erase an earlier
  successful mutation in the same command. Provider requests enforce the command deadline, reject
  redirects, and exclude raw transport/parser exceptions from public error causes.
- Application commands durably bind each tenant/connection ID to its provider, environment and
  account before claiming idempotency or reading provider mappings. Reusing a connection ID for a
  different environment or account fails closed.
- Provider idempotency keys must include tenant, connection, environment, method and endpoint scope.
  An arbitrary tracking reference or undocumented HTTP header does not establish safe POST replay.
  Dodo, Polar and Creem checkout recovery by repeating POST is disabled pending documented guarantees.
  Stripe replay requires a persisted original attempt time and stops before its 24-hour minimum
  retention window expires; older recovery records lacking that time fail closed.
- Polar's multiple `products` are customer alternatives, not a cart. Canonical multi-item checkout
  is unsupported. Dodo, Creem and Lemon Squeezy numeric custom prices use checked safe integers at
  the wire boundary; public Money continues to use decimal strings. Creem's documented custom-price
  bounds are 100 through 99999999, for one-time products only. Lemon checkout explicitly sends
  `test_mode` and restricts the enabled variant to the requested variant.
- Webhook event identities include tenant, connection, environment, provider, delivery, event type
  and aggregate. Waffo `id`/`eventId` identify business entities and are not globally unique
  deliveries; use a raw-body digest for deduplication. Lemon Squeezy's raw digest must also survive
  canonicalization so subsequent updates do not collapse into the first event.
- Dodo object lookup uses the event's resource kind (a refund contains both refund and payment IDs).
  Scheduled subscription cancellation notifications must not imply that current access has ended.
  Signed provider environment fields are checked against the resolved connection after verification.
- Polar documents a secret rollout at 2026-09-08 00:00 UTC: older secrets use the full secret's UTF-8
  bytes; new `whsec_` secrets use the base64-decoded suffix. Verify both documented key encodings,
  including active/previous key rotation, as the current official SDK guidance specifies.
- Failed queue dispatch remains recoverable from the persisted inbox. A retry can reclaim failed
  dispatch without deleting verified evidence. Applied records cannot be downgraded by a late
  duplicate failure. Inbox persistence failures return 5xx.
- x402 verification delegates nonce uniqueness to the durable inbox only in the unified handler,
  preventing nonce consumption before a failed inbox write. Standalone verification still claims
  the configured nonce store. Signed receipt trust and chain booleans/confirmation counts are
  runtime-checked, and fixed settlement requires explicit peg-risk acceptance.
- RSA signing and verification reject keys below 2048 bits and oversized PEM inputs. The fixed
  offline RSA vector is regenerated with OpenSSL using a 2048-bit fixture key.
- Refund input amount/currency/balance is checked before transport, and returned refund payment IDs
  must match the requested payment before any projection is committed.

## Official sources reviewed

| Provider | Sources | Relevant facts |
| --- | --- | --- |
| Stripe | [Idempotency](https://docs.stripe.com/api/idempotent_requests.md), [Checkout session](https://docs.stripe.com/api/checkout/sessions/object.md), [Create session](https://docs.stripe.com/api/checkout/sessions/create.md), [Webhooks](https://docs.stripe.com/webhooks.md) | Keys may be pruned after 24 hours; session completion and payment status differ; timestamped raw HMAC; test/live envelope |
| Dodo | [Official checkout SDK](https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/checkout-sessions.ts), [Official client](https://github.com/dodopayments/dodopayments-typescript/blob/main/src/client.ts), [Webhooks](https://docs.dodopayments.com/developer-resources/webhooks.md) | Numeric custom amount; Standard Webhooks; no enabled idempotency header in the inspected client |
| Polar | [Checkout API](https://polar.sh/docs/features/checkout/session.md), [2026-04 API](https://polar.sh/docs/api-reference/2026-04/introduction.md), [Webhook events](https://polar.sh/docs/integrate/webhooks/events.md), [Current signature rollout](https://polar.sh/docs/integrate/webhooks/delivery.md), [Legacy official verifier](https://github.com/polarsource/polar-js/blob/main/src/webhooks.ts) | Product selection differs from cart; old UTF-8 secrets and new Standard Webhooks secrets coexist from the documented September 8 rollout |
| Creem | [OpenAPI](https://docs.creem.io/api-reference/openapi.json), [Webhooks](https://docs.creem.io/code/webhooks.md) | `request_id` is documented for tracking; `custom_price` is a bounded integer; raw-body HMAC |
| Waffo Pancake | [Authentication](https://docs.waffo.ai/api-reference/authentication.md), [Checkout](https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session.md), [Webhooks](https://docs.waffo.ai/api-reference/webhooks.md) | RSA request canonicalization; environment-bound API keys; webhook IDs identify entities across lifecycle events |
| Lemon Squeezy | [Create checkout](https://docs.lemonsqueezy.com/api/checkouts/create-checkout), [Webhooks](https://docs.lemonsqueezy.com/guides/developer-guide/webhooks), [Subscription](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object) | Integer `custom_price`, explicit `test_mode`, enabled variants; raw HMAC; canceled subscription retains access until expiry |
| Paddle Billing | [Create transaction](https://developer.paddle.com/api-reference/transactions/create-transaction.md), [Signatures](https://developer.paddle.com/webhooks/about/signature-verification.md), [Adjustments](https://developer.paddle.com/api-reference/adjustments/create-adjustment.md) | Billing transaction checkout; timestamp/raw-body HMAC; full adjustment refunds |
| x402-paysdk | [Published package metadata](https://registry.npmjs.org/x402-paysdk/latest), [Public source](https://github.com/backrunner/x402-paysdk) | Merchant public API remains the boundary; receipt and chain verification remain required; no recurring mandate |

## Rollout and recovery

Provider API versions stay pinned where a version header is supported; fetching current documentation
does not authorize an untested API-version migration. Existing completed local idempotency results
remain replayable. Unknown outcomes lacking safe remote recovery require read-back/operator
reconciliation; never retry them under a new key. Event identity corrections can emit a new canonical
ID when replaying historical inbox rows; consumers must also deduplicate business effects by aggregate
and fact, and historical replay must not automatically fulfill orders.

Apply `0011_inbox_dispatch.sql` before deploying the updated D1 inbox. Custom stores must implement
`bindConnection` and `markQueued`; the connection registry uses the existing D1 control-plane table.
Old connections should be registered with their original provider/environment/account before commands
use their mappings. The dispatch lease is 60 seconds and a repeated enqueue may occur after an unknown
queue outcome; canonical event/outbox deduplication remains mandatory.

The pre-existing D1 contract test file exceeds the 600-line guideline. This review retains that shared
Miniflare migration fixture and records the exception; new transport and mutation tests are separate
files. No implementation source added by this review exceeds 600 lines.

## Verification result

Passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (including build), `pnpm test:unit`,
`pnpm test:contract`, `pnpm test:workerd`, `pnpm test:migration`, `pnpm test:security`,
`pnpm check:packages`, and `pnpm check:worker-bundle`. The subsequent Polar secret-rollout correction
passed its independent legacy/Standard Webhooks vectors and adapter contracts; the final mutation
contracts and Worker bundle were also rechecked after the last implementation changes.

Earlier runs under concurrent machine/build load hit D1 test/hook timeouts. These were retained as
failures, without automatic retries or relaxed assertions. The isolated D1 run passed 16 tests; the
subsequent sequential required-check run also passed the full D1 and workerd suites.

Provider-owned sandbox checks and live transactions were **not run**. No adapter is promoted beyond
experimental, and the review does not replace account-specific API, commercial-terms, and finality
verification before production rollout.
