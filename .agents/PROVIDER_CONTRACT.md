# Provider Adapter Contract

## 1. SPI shape

Adapter 是一组按资源拆分的 port，而不是充满 optional method 的巨型 interface：

```ts
interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  getCapabilities(ctx: ProviderContext): Promise<CapabilitySnapshot>;
  readonly catalog?: CatalogProvider;
  readonly customers?: CustomerProvider;
  readonly checkout?: CheckoutProvider;
  readonly orders?: OrderProvider;
  readonly subscriptions?: SubscriptionProvider;
  readonly refunds?: RefundProvider;
  readonly discounts?: DiscountProvider;
  readonly licensing?: NativeLicensingProvider;
  readonly usage?: UsageProvider;
  readonly webhooks: WebhookProvider;
  readonly reconcile: ReconcileProvider;
}
```

资源 port 的存在不等于所有操作都可用；具体 operation 仍由 capability snapshot 决定。

`ProviderDescriptor` 固定 provider/product line 和默认商业模型；账户与地区的真实责任由动态
snapshot 决定：

```ts
type CommercialModel = "merchant_of_record" | "payment_processor" | "settlement_network";

interface CommercialTermsSnapshot {
  readonly model: CommercialModel;
  readonly sellerOfRecord: "provider" | "merchant" | "conditional";
  readonly taxCalculation: "provider" | "merchant" | "shared" | "conditional";
  readonly taxInvoiceIssuer: "provider" | "merchant" | "none" | "conditional";
  readonly disputeResponsibility: "provider" | "merchant" | "shared" | "conditional";
  readonly jurisdictions?: readonly string[];
  readonly termsVersion?: string;
  readonly observedAt: IsoDateTime;
  readonly evidenceRef: EvidenceId;
}
```

Capability snapshot 包含该结构。adapter 不得仅凭营销名称硬编码 account-level 结论；conditional
字段必须带 constraints，并在 checkout context 已知后重新解析或拒绝。

## 2. Provider context

```ts
interface ProviderContext {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly credentials: ResolvedCredentials;
  readonly requestId: RequestId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly deadline: IsoDateTime;
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: CryptoPort;
  readonly clock: Clock;
}
```

Context 每次调用创建，不允许 adapter 把 credential 或 tenant 放入全局单例。`deadline` 必须
转换为 AbortSignal；provider SDK 无法接收 signal 时应包在受控 transport 内。

## 3. Capability keys

首版 key 至少包括：

```text
catalog.product.read/create/update/archive
catalog.price.read/create/retire
customer.read/create/update/delete/portal
checkout.hosted/embedded/ad_hoc_price/multi_item/discount/tax
order.read/list
payment.one_time/payment.asset_settlement/refund.partial/refund.full/dispute.read
subscription.create/read/list/change_items/pause/resume/cancel/proration/trial/mandate
commercial.merchant_of_record/tax_calculation/tax_invoice/dispute_responsibility
discount.create/redeem
license.issue/validate/activate/deactivate/revoke
usage.meter/ingest/credit
webhook.verify/replay/simulate
migration.catalog/customer/subscription/payment_method
```

Capability value（与架构中的 descriptor 同源，实际代码只保留一份定义）：

```ts
interface CapabilityBase {
  readonly environments: readonly Environment[];
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly limits?: CapabilityLimits;
  readonly migration: "portable" | "recreate" | "reauthorize" | "pinned";
}

type Capability =
  | (CapabilityBase & { support: "native"; fidelity: "exact" })
  | (CapabilityBase & {
      support: "emulated";
      fidelity: "exact" | "lossy" | "workflow";
      strategy: string;
    })
  | (CapabilityBase & {
      support: "unsupported";
      reason: string;
      alternatives?: readonly string[];
    });
```

`workflow` 表示返回下一步操作而非已经完成，例如 customer 每期重新授权；调用者必须能在类型上
区分 workflow result，不能把它当作 provider mutation success。

Snapshot 包含 `adapterVersion`、`providerApiVersion`、`commercialTerms`、`observedAt` 和可选
`expiresAt`。静态声明与账户级动态 capability 合并，例如某账户未开通特定 payment method。

## 4. Example resource contract

```ts
interface CheckoutProvider {
  create(
    ctx: ProviderContext,
    command: ProviderCheckoutCommand,
  ): Promise<ProviderOperationResult<ProviderCheckoutSnapshot>>;

  get(
    ctx: ProviderContext,
    externalId: string,
  ): Promise<ProviderCheckoutSnapshot>;
}

interface ProviderOperationResult<T> {
  readonly value: T;
  readonly evidence: ProviderEvidence;
  readonly idempotency: "provider" | "polybill" | "both";
  readonly warnings: readonly PortabilityWarning[];
}
```

Provider command 已由 application layer 解析 canonical ID，adapter 不查询 store。adapter 只能
返回 provider snapshot/evidence，不能自行修改 canonical DB。

## 5. Mapping rules

每个 adapter 为每个对象维护双向 mapper：

- `toProvider(command, mappings, capabilities)`
- `fromProvider(snapshot, context)`
- `eventToCanonical(rawEvent, mappings)`

mapper 是纯函数并由 golden fixtures 测试。未知 enum 必须映射到 `unknown`/evidence，不能 cast
成已知值。provider 新增字段不会自动进入 public output；经过 schema 和设计审查后才提升。

所有 provider 状态映射表在 adapter 文档和测试中穷举。例如 provider 的 cancellation-pending
映射为 `status: active` 加 `scheduledChange: cancel`，不能直接映射成 canonical canceled。

## 6. Ad hoc price policy

Canonical request 明确选择：

```ts
type CheckoutPricing =
  | { kind: "catalog"; priceId: PriceId }
  | { kind: "ad_hoc"; price: PriceModel; persistence: "session" | "reusable" };
```

- provider 支持 non-catalog/inline item：`native/exact`。
- provider 只能创建目录对象：在调用者允许 `temporary_catalog_object` 后为
  `emulated/exact`，并记录对象生命周期；不能保证删除时只 archive。
- provider 只允许 dashboard 预建变体：`unsupported`，要求调用者先做 catalog sync。
- pay-what-you-want 不等价于服务端任意定价；capability constraint 必须标明金额由谁选择。

## 7. Idempotency

每个 mutation 必须声明 provider strategy：

- 原生 header/key，例如 Stripe-style idempotency。
- body/external reference 唯一键。
- Polybill claim + query-before-create emulation。
- 无可靠策略：capability 标记 `at_most_once_risk`，默认拒绝自动 retry。

adapter 将 canonical idempotency key hash/缩短到 provider 限制，但 evidence 保存映射。相同 key
配不同 canonical payload 返回 `idempotency_conflict`。

超时后恢复顺序：按原生 idempotency 查询结果、按 external reference 搜索、执行 read-back、
最后返回 `outcome_unknown`。不得直接生成新 key 重试。

## 8. Error model

```ts
type PolybillErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_response_invalid"
  | "unsupported_capability"
  | "idempotency_conflict"
  | "outcome_unknown"
  | "signature_invalid"
  | "replay_rejected";

interface PolybillError extends Error {
  readonly code: PolybillErrorCode;
  readonly operation: string;
  readonly provider?: ProviderName;
  readonly connectionId?: ConnectionId;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly evidenceRef?: EvidenceId;
}
```

错误 message 不含 request body、credential、customer PII 或 license key。HTTP status 只是分类
输入；adapter 还需解析 provider error code，区分软失败、硬失败和未知结果。

## 9. Retry and rate limiting

- 默认只重试连接错误、超时前未发送、429 和明确可重试 5xx。
- 400/401/403/404/409 不重试，除非 provider 明确文档化例外。
- mutation 只有在 idempotency strategy 安全时自动重试。
- 指数 backoff + full jitter，尊重 `Retry-After`，受 command deadline 限制。
- limiter key 为 `(connectionId, operation class)`；一家账户限流不阻塞其他 tenant。

## 10. Pagination and consistency

公共 list API 使用 opaque Polybill cursor。adapter cursor 被加密/签名包装，调用者不能依赖
provider pagination 格式。import/reconcile 将 cursor 和 high-water mark 持久化，支持 resume。

对于最终一致的 provider list，adapter 必须提供 `get(id)` read-after-write 路径。迁移 verify
不得只依赖刚写后的 list 结果。

## 11. Webhook contract

```ts
interface WebhookProvider {
  verify(input: {
    rawBody: Uint8Array;
    headers: Headers;
    secret: ResolvedWebhookSecret;
    now: IsoDateTime;
  }): Promise<VerifiedProviderEvent>;

  decode(event: VerifiedProviderEvent): DecodedProviderEvent;
  map(event: DecodedProviderEvent, lookup: MappingLookup): Promise<CanonicalEventDraft[]>;
}
```

`verify` 不得解析后再 stringify。header 名大小写不敏感；多值签名、secret rotation、timestamp
tolerance 和重放规则由 provider 实现。`VerifiedProviderEvent` 必须给出 provider delivery ID；若
provider 没有该字段，则按 adapter 文档从 raw bytes 计算带命名空间的 SHA-256 delivery key。
`decode` 的 input 仍视为 untrusted bytes/string。

## 12. Reconciliation contract

每个 adapter 至少提供：

- 按 external ID fetch authoritative resource。
- 按更新时间/游标 list 可变资源，若 provider 支持。
- 将 provider snapshot 与 canonical projection 比较。
- 输出 `missing_local | missing_remote | state_mismatch | amount_mismatch | mapping_conflict |
  unknown_remote_state`，不默认自动覆盖。

自动修复仅限有单一权威答案且无业务 side effect 的 projection。退款、entitlement revoke、
subscription cancel 等修复需 policy 或人工审批。

## 13. Provider-specific extensions

无法合理统一的能力通过 provider 包的显式 subpath 提供，例如：

```ts
import { stripeExtension } from "@polybill/provider-stripe/extensions";
```

extension 接收 connection/context，仍使用 Polybill transport、redaction 和 evidence。使用
extension 会在 portability report 中标记该 workflow `provider_pinned`。公共 facade 不增加
`rawRequest()`，避免绕过认证、schema、SSRF 和审计边界。

## 14. Adapter release gate

一个 adapter 只有在满足以下条件后才能从 experimental 提升 stable：

- capability matrix 有官方来源和核验日期。
- 所有声明 native 的操作通过 conformance suite。
- test/live base URL 和 secret isolation 有测试。
- webhook 有 valid、invalid、old timestamp、duplicate、rotation、unknown event fixtures。
- timeout、429、5xx、invalid JSON、oversized body 和 outcome unknown 有测试。
- workerd bundle 无 Node built-in，Miniflare smoke 通过。
- migration importer 可 dry-run、resume，且不会重复创建。
