# Provider 调研与能力矩阵

调研日期：2026-08-25。以下结论来自供应商官方文档、官方/维护者 SDK、OpenAPI 或本机
`backrunner/x402-paysdk` 源码。API 和产品能力会变化；adapter 必须在源码中记录文档 URL、
provider API version、核验日期和 fixture 版本，不能把本表当成永久承诺。

## 1. 统一解读

- `Native`：provider API 直接提供且语义可映射。
- `Emulated`：Polybill 在 control plane 中提供；支付/税务/法律责任仍不等于 provider 原生能力。
- `Conditional`：账户、地区、产品审核、payment method 或 API 版本决定是否可用。
- `Unsupported`：不能诚实映射；必须在请求前返回结构化错误。
- 所有 provider 的 test/live 对象、secret、webhook destination 和 ID 都隔离；连接配置必须
  明确 environment。

## 2. Matrix

基线商业模型：Dodo、Polar、Creem、Waffo Pancake、Lemon Squeezy 和 Paddle Billing 按各自文档
作为 MoR 产品接入；Stripe 基础 adapter 按 payment processor/PSP 接入，不把 Stripe 的其他产品
自动视为 MoR；x402 是 non-custodial settlement network。实际 seller/tax/invoice 责任仍按账户、
地区和当前条款形成 `CommercialTermsSnapshot`，本矩阵不是法律意见。

| Provider | Test/live 与 checkout | Catalog / price | Subscription / customer | License / entitlement | Webhook 与测试 | 迁移事实与 Polybill 策略 |
| --- | --- | --- | --- | --- | --- | --- |
| **Stripe** | Sandboxes/test API keys 与 live keys 完全隔离；Checkout Sessions 支持一次性和订阅 | Product + Price、coupons/promotion codes、pay-what-you-want、usage-based、multi-currency | Billing、customer portal、trial、pause、upgrade/downgrade、meter usage | Entitlements 有 API；没有通用“生成/激活 license key”账务 API，Polybill-owned license | `Stripe-Signature`；Stripe CLI、Dashboard trigger、sandbox test cards、Billing test clocks；CLI 事件 payload 可能是 fake data | 没有通用跨 provider token 复制保证；catalog 可导入，active mandate/subscription 需 provider-assisted 或 reauthorize |
| **Dodo Payments** | `https://test.dodopayments.com` 与 `https://live.dodopayments.com`；test/live 数据、key、webhook 独立 | 一次性、订阅、usage、seat/add-on、discount、pay-what-you-want、dynamic pricing | customer、portal、trial、proration、upgrade/downgrade、on-demand charge | Native license keys、entitlement grants、digital delivery、credits | Standard Webhooks HMAC-SHA256；最多 8 次 exponential retry，`webhook-id` 幂等；test cards、CLI listener、Cloudflare example | 官方 subscription migration 目前可搬 card tokens，但需 support/Solutions Engineer；Apple/Google Pay 等 wallet token 不可转。默认 `reauthorize` |
| **Polar** | 独立 `sandbox.polar.sh`/`sandbox-api.polar.sh`，生产为 `api.polar.sh`；sandbox 账号和 token 独立 | Product + fixed/custom/seat/metered price、recurring、discount、custom fields | customer、checkout、portal、trial、pause/resume/cancel、proration、failed payment recovery | Benefits 包括 license keys、file/Discord/GitHub 等；Polybill 仍以自有 grant 为真源 | Standard Webhooks；内置 validate helper；10 次 exponential retry，连续失败会禁用；CLI `polar listen`；sandbox Stripe test cards | 有 “migrate away” 文档，但不会推导通用目标 provider 的 token/subscription import；catalog/customer mapping 可做，payment method 需 workflow |
| **Creem** | `https://test-api.creem.io` 与 `https://api.creem.io`，test/live key 不可混用 | Product、one-time/subscription、trials、discount、pay-what-you-want/动态 checkout（以 API version 验证） | customer、portal、subscription pause/resume/upgrade/downgrade/cancel、refund | Native license list/validate/activate/deactivate，product 可启用 license feature | `creem-signature` HMAC-SHA256 raw body；5 次（initial + 30s/5m/30m/6h），24h 后停止；test cards 和 test webhook URL | 官方 CLI 可从 Lemon Squeezy 迁 catalog；active subscriptions 不自动迁移，需自然续费/重新订阅。Polybill 仍不依赖其 license 作为唯一真源 |
| **Waffo Pancake** | Test/Production store 与 key 独立，webhook payload 有 `mode` 和 `X-Environment`；production 需 KYB | One-time/recurring product、multi-currency price、immutable product version、checkout session、tax preview | customer、subscription、portal、refund ticket；部分 change-product 文档标为 Coming Soon | 当前 feature/API docs 没有可承诺的通用 license-key API；Polybill-owned license/entitlement | `X-Waffo-Signature: t=...,v1=...` RSA-SHA256，环境 public key；Dashboard Send Test Event；eventId 幂等 | 官方 migrate CLI 仅 Stripe/Creem products/prices/webhooks/branding；active subs/customers/payment methods/coupons 不迁。`@waffo/pancake-ts` 以 `node:crypto` 签名，Cloudflare 用 Polybill Web Crypto REST adapter |
| **Lemon Squeezy** | Store test mode 与 live mode 隔离；test API key 只看 test store data | Product/Variant/Price、discount、checkout `custom_price`、multi-variant | subscriptions、trial/pause/past_due/unpaid/cancelled/expired、customer portal、payment method URL | Native License Key API（validate/activate/deactivate）和自动发放；Polybill 做 mirror/portable grant | `X-Signature` HMAC-SHA256 raw body；非 200 最多重试四次；test mode 可模拟 subscription webhook；test file downloads disabled | 无通用 payment token migration 依据；catalog/import + parallel renewals；旧 subscription 需 source/reauthorize |
| **Paddle Billing** | Production `api.paddle.com`、sandbox `sandbox-api.paddle.com`；Billing 与 Classic 不混用 | Product/Price、country price overrides、discount、non-catalog product/price/custom amount、preview | customer/address/business、portal、multi-item subscription、pause/resume/cancel/proration、manual/automatic collection | Billing 文档要求应用自己做 fulfillment；Classic license 概念不能当作 Billing native，Polybill-owned | `Paddle-Signature` HMAC-SHA256 over timestamp/raw body；5 秒内 ack；官方 webhook simulator、scenario/replay | 官方 migration 文档不能保证 generic saved-card import；可迁 catalog/mapping，active payment method 要 reauthorize 或 provider program |
| **x402** | 不提供传统 test/live account；按 chain/network、facilitator 和 RPC 配置区分测试网/正式网 | Product/SKU/price 由 Polybill；PaymentRef 接收 USDC atomic amount，必须由显式 settlement quote/policy 得出 | 不提供 customer、card method、subscription mandate | Polybill-owned license/voucher/entitlement；receipt 证明结算，不发行 license | `x402-paysdk` gateway/merchant notify 与 signed receipt；本地 fake facilitator、D1 Worker 可测试 | 一次性链上支付；没有跨 provider 的 recurring card token。每期需新 PaymentRef/签名/settlement，或把订阅留在另一个 connection |

## 3. 官方来源

### Stripe

- [Testing and sandboxes](https://docs.stripe.com/test-mode.md)
- [Billing testing and test clocks](https://docs.stripe.com/billing/testing.md)
- [Webhooks](https://docs.stripe.com/webhooks.md)
- [Products and prices](https://docs.stripe.com/products-prices/overview.md)
- [Coupons](https://docs.stripe.com/api/coupons/create.md)
- [Checkout Session create](https://docs.stripe.com/api/checkout/sessions/create.md)
- [Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object.md)
- [Customer portal](https://docs.stripe.com/customer-management.md)
- [Entitlements](https://docs.stripe.com/billing/entitlements.md)
- [Merchant of record and payments responsibilities](https://docs.stripe.com/payments/managed-payments.md)
- [Stripe Node worker exports](https://github.com/stripe/stripe-node)

### Dodo Payments

- [Test mode vs live mode](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode.md)
- [Testing process](https://docs.dodopayments.com/miscellaneous/testing-process.md)
- [Products and subscriptions](https://docs.dodopayments.com/features/products.md)
- [License keys](https://docs.dodopayments.com/features/license-keys.md)
- [Webhooks](https://docs.dodopayments.com/developer-resources/webhooks.md)
- [Dynamic pricing checkout](https://docs.dodopayments.com/developer-resources/dynamic-pricing-checkout.md)
- [Subscription migration](https://docs.dodopayments.com/miscellaneous/subscription-migration.md)
- [Cloudflare webhook example](https://docs.dodopayments.com/developer-resources/webhooks/examples/cloudflare-example.md)
- [Official TypeScript SDK](https://github.com/dodopayments/dodopayments-typescript)

### Polar

- [API versioning](https://polar.sh/docs/api-reference/2026-10/versioning.md)
- [API changelog](https://polar.sh/docs/changelog/api.md)
- [2026-10 compatibility review and upgrade procedure](./POLAR_API_2026-10.md)
- [Sandbox environment](https://polar.sh/docs/integrate/sandbox.md)
- [Products](https://polar.sh/docs/features/products.md)
- [License-key benefit](https://polar.sh/docs/features/benefits/license-keys.md)
- [Subscriptions](https://polar.sh/docs/features/subscriptions/introduction.md)
- [Webhook delivery](https://polar.sh/docs/integrate/webhooks/delivery.md)
- [Local webhook listener](https://polar.sh/docs/integrate/webhooks/locally.md)
- [Migrate away](https://polar.sh/docs/migrate-away.md)
- [Product API schema](https://polar.sh/docs/api-reference/2026-04/products/create-product.md)
- [Official TypeScript SDK](https://github.com/polarsource/polar-js)

### Creem

- [Test mode](https://docs.creem.io/getting-started/test-mode.md)
- [Webhooks](https://docs.creem.io/code/webhooks.md)
- [Migrate](https://docs.creem.io/getting-started/migrate.md)
- [License keys](https://docs.creem.io/features/addons/licenses.md)
- [API OpenAPI](https://docs.creem.io/api-reference/openapi.json)
- [Official SDK repository](https://github.com/armitage-labs/creem/tree/main/packages/creem-sdk)

### Waffo Pancake

- [Test mode](https://docs.waffo.ai/features/test-mode.md)
- [Webhook API](https://docs.waffo.ai/api-reference/webhooks.md)
- [AI integration / SDK](https://docs.waffo.ai/integrate/ai-integration.md)
- [Migration](https://docs.waffo.ai/integrate/migrate.md)
- [Products](https://docs.waffo.ai/features/products.md)
- [Official TS SDK](https://github.com/waffo-com/waffo-pancake-sdk-ts)

### Lemon Squeezy

- [Test mode](https://docs.lemonsqueezy.com/help/getting-started/test-mode)
- [API](https://docs.lemonsqueezy.com/api)
- [Webhook guide](https://docs.lemonsqueezy.com/guides/developer-guide/webhooks)
- [License API](https://docs.lemonsqueezy.com/api/license-api)
- [Official JavaScript SDK](https://github.com/lmsqueezy/lemonsqueezy.js)

### Paddle Billing

- [Billing vs Classic](https://developer.paddle.com/llms.txt)
- [Sandbox](https://developer.paddle.com/build/tools/sandbox)
- [Products and prices](https://developer.paddle.com/api-reference/products.md)
- [Non-catalog transaction items](https://developer.paddle.com/api-reference/transactions/create-transaction.md)
- [Webhook delivery](https://developer.paddle.com/webhooks/about/how-webhooks-work.md)
- [Webhook signature](https://developer.paddle.com/webhooks/about/signature-verification.md)
- [Webhook simulator](https://developer.paddle.com/webhooks/simulator/test-webhooks.md)
- [Official Node SDK with edge exports](https://github.com/PaddleHQ/paddle-node-sdk)

### x402-paysdk

- [npm package](https://www.npmjs.com/package/x402-paysdk)
- [source repository](https://github.com/backrunner/x402-paysdk)
- Local source reviewed: `../x402-qrpay/sdk/merchant-sdk`, `sdk/shared-x402`,
  `crates/gateway-worker`.

本地 `0.1.0` 额外确认：merchant Order/PaymentRef 的 `amount` 是 USDC 6-decimal atomic string；
receipt 固定带 network、chain ID、asset contract、symbol 和 decimals。merchant runtime 没有
`node:*` import，但 public `MerchantClient` 当前固定使用 global `fetch`，所以 Polybill stable gate
要求 transport/AbortSignal 注入或经兼容测试的 public `request()` override。

### Cloudflare

- [Workers runtime APIs](https://developers.cloudflare.com/workers/runtime-apis/)
- [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [D1](https://developers.cloudflare.com/d1/)
- [D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [Queues](https://developers.cloudflare.com/queues/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/)

## 4. Capability conclusions

### Portable in v1

Product/SKU intent、fixed one-time price、hosted checkout URL、customer external ID、order/payment
projection、basic refund、basic recurring subscription、cancel-at-period-end、provider webhook inbox、
Polybill-owned license/voucher/entitlement 和 catalog mapping。

### Emulated with an explicit warning

任意 provider 的 license key、voucher/card redemption、customer portal abstraction（底层返回
不同 provider URL）、ad hoc price（若目标 provider 只支持临时目录对象）、usage/credit ledger、
unified customer state、provider lacking discount 的 entitlement discount。

### Not safely universal

saved payment method token、bank mandate、active subscription billing authorization、tax/legal
invoice migration、dispute ownership、marketplace split、provider-specific fraud/risk decision、
x402 automatic recurring debit。

## 5. Open verification gates before coding each adapter

1. Pin provider API/OpenAPI version and fetch schema into sanitized fixture.
2. Create test/live connections and verify object ID namespace isolation.
3. Verify exact webhook signature input, timestamp tolerance, event ID and retry schedule.
4. Confirm refund semantics, partial refund limits, proration and cancellation access window.
5. Confirm currency exponent/minor-unit rules; do not assume all currencies use two decimals.
6. Verify customer portal URL lifetime and whether it can be generated from server only.
7. Verify legal seller/MoR and tax evidence retention obligations with compliance owner.
8. Run edge bundle check; if official SDK imports Node built-ins, use REST/Web Crypto implementation.
