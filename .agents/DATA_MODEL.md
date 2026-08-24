# Canonical 数据模型

## 1. Primitive types

```ts
type Brand<T, N extends string> = T & { readonly __brand: N };

type MinorUnit = Brand<string, "MinorUnit">;       // /^(0|[1-9][0-9]*)$/
type AtomicUnit = Brand<string, "AtomicUnit">;     // /^(0|[1-9][0-9]*)$/
type Currency = Brand<string, "Currency">;         // uppercase ISO-4217
type IsoDateTime = Brand<string, "IsoDateTime">;   // RFC 3339 UTC
type PolybillId = Brand<string, "PolybillId">;

interface Money {
  readonly amount: MinorUnit;
  readonly currency: Currency;
}

interface DigitalAsset {
  readonly network: string;      // CAIP-2 where supported, for example eip155:8453
  readonly assetId: string;      // verified contract/address or protocol asset identifier
  readonly symbol: string;       // display only; never establishes identity
  readonly decimals: number;
}

interface AssetAmount {
  readonly amount: AtomicUnit;
  readonly asset: DigitalAsset;
}
```

使用字符串是为了 JSON、D1 和跨运行时无损传输；所有加减乘除先通过受控 helper 转成
`bigint`。禁止接受 `10.99` 或 JavaScript `number` 作为公共金额。`Money` 用于商品/订单的
ISO-4217 计价，`AssetAmount` 用于链上结算；两者是不同 branded type，不能按相同数字直接转换。

```ts
interface SettlementQuote {
  readonly id: SettlementQuoteId;
  readonly pricingAmount: Money;
  readonly settlementAmount: AssetAmount;
  readonly source: "merchant_fixed" | "quote_provider";
  readonly quotedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}
```

quote 必须绑定 tenant、connection、Order、计价总额和 settlement tuple，并在创建 PaymentRef 前
验证有效期。`merchant_fixed` 仍是显式接受稳定币脱锚风险的商户策略，不是 SDK 内建的 USD/USDC
等价假设。

ID 采用带前缀的随机/时间有序值，例如 `prod_`、`sku_`、`price_`、`cust_`、`ord_`、
`pay_`、`sub_`。provider ID 永远位于 mapping，不作为 canonical ID。

## 2. Catalog aggregates

### Product

描述用户看到的商品：name、description、media、tax category、metadata、active/archived。Product
不含金额或周期，避免 provider 把价格内嵌时污染模型。

### SKU

稳定的可售变体：

```ts
interface Sku {
  readonly id: SkuId;
  readonly productId: ProductId;
  readonly key: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly fulfillment: "digital" | "service";
  readonly taxCategory: TaxCategory;
  readonly entitlementPolicyIds: readonly EntitlementPolicyId[];
  readonly status: "active" | "archived";
  readonly version: number;
}
```

`key` 在 tenant 内唯一且长期稳定，用于从宿主配置引用。

### Price

Price 不可变；变价创建新版本并 retire 旧价。核心 price union：

```ts
type PriceModel =
  | { kind: "one_time"; unit: Money }
  | { kind: "recurring"; unit: Money; interval: BillingInterval }
  | { kind: "seat"; unit: Money; interval: BillingInterval }
  | { kind: "metered"; meterId: MeterId; interval: BillingInterval; tiers: readonly Tier[] }
  | { kind: "custom"; minimum?: Money; suggested?: Money }
  | { kind: "free"; currency: Currency };
```

localized override、tax behavior、trial policy 是显式字段。不能把 tax-inclusive 与
tax-exclusive 价格视为同一版本。免费价格仍必须声明币种，使全免费订单、税务上下文和目标
provider catalog mapping 不依赖隐式 USD 默认值。

## 3. Customer and identity

Customer 保存 Polybill identity、宿主 `externalId`、最少 PII 和 provider mappings。email 可以
变化，不是主键。一个 customer 可在多个 provider connection 有不同 mapping。

Provider payment method 只保存 opaque ID、brand/last4 等非敏感摘要和可移植性标签，不保存
PAN、CVC、银行凭据或 wallet token。

## 4. Commerce aggregates

### CheckoutSession

状态：`open | complete | expired | canceled`。它是短期交互对象，不等价于 Order 或 Payment。
保存 success/cancel URL、line item snapshot、customer ref、provider URL 和 expiry。

### Order

```ts
type OrderPaymentStatus =
  | "pending" | "paid" | "partially_refunded" | "refunded"
  | "failed" | "canceled" | "disputed";

type FulfillmentStatus =
  | "unfulfilled" | "processing" | "fulfilled" | "revoked";
```

两个状态分别推进。支付成功不能自动推断数字权限已发放；业务 consumer 决定 fulfillment。
OrderLine 保存购买时的 product/SKU/price snapshot，目录更新不能改历史订单。

Order 同时保存创建时的 `commercialTermsRef`、`sellerOfRecord`、tax behavior、invoice issuer 和
terms version。它们是历史交易事实，connection 后续变更不能回写；provider 发票只保存受控
reference/URL/evidence，不伪造为 Polybill 自己签发的税务文件。

### Payment

状态机：

```text
pending -> requires_action -> processing -> succeeded
   |             |              |             |
   +-----------> failed <-------+             +-> disputed (separate fact)
   +-----------> canceled
```

`succeeded`、`failed`、`canceled` 对一次 provider attempt 是终态；新重试创建新的 attempt，
不是逆转旧 attempt。Payment 保存 amount authorized/captured/refunded、evidence 和 risk flags。
数字资产 Payment 还保存原 Order `Money`、`SettlementQuote`、实际 `AssetAmount` 和 receipt tuple，
使对账能够同时发现计价错误和链上少付/错资产。

### Refund

状态：`pending | requires_action | succeeded | failed | canceled`。每笔 refund 有独立 ID 和
idempotency key。Order 的 refunded amount 是 refund ledger 聚合结果，不能由 webhook payload
直接覆盖。

### Dispute

状态：`warning_needs_response | needs_response | under_review | won | lost | closed | unknown`。
保留 provider deadline 和 evidence URL。不同 MoR 的争议响应能力不统一，因此 core 先保证
读取和事件同步，写操作通过 capability extension。

## 5. Subscription aggregate

```ts
type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "unpaid"
  | "canceled";

interface ScheduledChange {
  readonly kind: "cancel" | "pause" | "resume" | "items";
  readonly effectiveAt: IsoDateTime;
}
```

订阅项目变更和暂停不能只用一个动词表示。项目变更命令必须同时声明生效时间与 proration：

```ts
interface SubscriptionItemChangePolicy {
  readonly timing: "immediately" | "period_end";
  readonly proration: "none" | "prorate_next_invoice" | "prorate_immediately";
}

interface SubscriptionPausePolicy {
  readonly timing: "immediately" | "period_end";
  readonly invoiceBehavior:
    | "stop_billing"
    | "void"
    | "keep_draft"
    | "mark_uncollectible";
}
```

`period_end + prorate_immediately` 是矛盾组合，必须在 transport 前拒绝。`stop_billing` 表示暂停期
不生成账单；其余三种表示 provider 仍生成账单但分别作废、保留草稿或标记不可收取。adapter 只有
在 provider 同时匹配 timing、proration 和 invoice behavior 时才能声明 `native/exact`；例如仅有
“暂停收款”但 subscription billing period 继续推进的 API，不能冒充 `stop_billing`。

取消中不增加一个混合状态：保持当前 billing status，并设置 `scheduledChange` 和
`accessUntil`。provider raw status、period、trial、collection method、items 和 proration evidence
保存在 snapshot。

合法转移由 adapter observation 和 command result 驱动。乱序 webhook 的 `occurredAt` 早于当前
version 时只进入 audit，不覆盖新状态；同 timestamp 冲突时触发 API reconciliation。

订阅 billing 状态不直接决定 entitlement：`past_due` 是否保留宽限期由
`EntitlementPolicy` 决定。

## 6. Entitlement、license 与 voucher

### EntitlementPolicy and Grant

Policy 描述购买 SKU 后授予什么、何时撤销以及 grace period。Grant 状态：
`pending | active | suspended | revoked | expired`。来源可以是 order、subscription、manual、
voucher 或 migration。

Policy 创建和 Grant 创建都必须携带 tenant-scoped idempotency key。一个 source 可以按多个 policy
产生独立 Grant，因此来源唯一键是 `(tenant, policy, source, sourceRef)`，不能只按 sourceRef 去重。
同一 idempotency key 和 payload 重放返回原 Grant；同一 policy/source 使用另一 key 重复创建时返回
conflict，防止一个新 key 在未留下 claim 的情况下被误认为成功。状态迁移只允许：

```text
pending   -> active | revoked | expired
active    -> suspended | revoked | expired
suspended -> active | revoked | expired
revoked   -> (terminal)
expired   -> (terminal)
```

每次状态迁移携带 idempotency key，并由 Store 以条件更新和 transition ledger 原子提交。Grant 保存
`grantedAt` 和 `updatedAt`；过期时间到达后不得签发、激活或验证 license，即使异步 expiry projection
尚未把状态写成 `expired`。License 的 tenant 与 Grant tenant 必须同时匹配。

### License

```ts
interface LicenseRecord {
  readonly id: LicenseId;
  readonly digest: string;          // HMAC-SHA-256 lookup digest
  readonly encryptedValue?: string; // only when re-display is required
  readonly status: "active" | "suspended" | "revoked" | "expired";
  readonly activationLimit: number;
  readonly expiresAt?: IsoDateTime;
  readonly ownerRef?: CustomerId;
  readonly grantId: EntitlementGrantId;
}
```

明文 key 只在生成时返回一次。`LicenseInstance` 以 instance ID、设备摘要、首次/最近校验时间和
deactivatedAt 建模。激活使用 compare-and-set，不能先 count 再 insert。

### Voucher/Card

`VoucherBatch` 定义 prefix、数量、权益/余额、次数、有效期和 campaign。`Voucher` 保存 digest、
remaining uses/value 和状态。`Redemption` 是不可变 ledger：

```text
active --atomic redeem--> partially_redeemed | redeemed
active -----------------> expired | revoked
```

单次码的事务条件是 `status = active AND remaining_uses > 0`；成功扣减和创建 redemption 必须
在一个事务/Durable Object turn 内完成。

## 7. Provider mappings and evidence

```ts
interface ProviderMapping {
  tenantId: TenantId;
  connectionId: ConnectionId;
  environment: Environment;
  entityType: CanonicalEntityType;
  entityId: PolybillId;
  externalId: string;
  externalParentId?: string;
  mappingVersion: number;
  source: "created" | "imported" | "observed";
}
```

唯一约束：

- `(tenant_id, connection_id, entity_type, entity_id)`
- `(tenant_id, connection_id, entity_type, external_id)`

Evidence 保存 provider request ID、event ID、resource version、API version 和加密/raw blob
reference。它不能包含 credential、PAN、CVC 或完整敏感 headers。

## 8. Event envelope

```ts
interface CanonicalBillingEvent<TType extends string, TData> {
  readonly id: EventId;
  readonly schemaVersion: 1;
  readonly type: TType;
  readonly tenantId: TenantId;
  readonly connectionId: ConnectionId;
  readonly environment: Environment;
  readonly aggregate: { type: string; id: PolybillId };
  readonly occurredAt: IsoDateTime;
  readonly observedAt: IsoDateTime;
  readonly data: TData;
  readonly evidenceRef: EvidenceId;
}
```

事件命名示例：`payment.succeeded.v1`、`subscription.changed.v1`、
`entitlement.granted.v1`。schema version 属于 envelope/data，不跟随 provider API version。

## 9. Control-plane schema

官方 store 至少实现以下逻辑表：

| Table | Purpose | Critical key |
| --- | --- | --- |
| `polybill_connections` | provider/environment/account metadata | tenant + connection |
| `polybill_mappings` | canonical/external ID map | connection + type + IDs |
| `polybill_idempotency` | command claim and saved result | connection + operation + key |
| `polybill_inbox` | verified raw event receipt | connection + external delivery key |
| `polybill_outbox` | canonical/application event delivery | event ID + destination |
| `polybill_snapshots` | latest canonical aggregate projection | type + canonical ID |
| `polybill_catalog_*` | optional Product/SKU/Price source | stable IDs + versions |
| `polybill_entitlement_*` | policy、grants and transition ledger | policy + source + idempotency key |
| `polybill_licenses` | key digest and state | tenant + digest |
| `polybill_license_instances` | activations | license + instance ID |
| `polybill_voucher_*` | batches, code digest, redemptions | tenant + digest |
| `polybill_migration_*` | plans, items, checkpoints | migration + item key |
| `polybill_reconciliation_checkpoints` | authoritative refresh cursor | connection + stream |
| `polybill_audit` | immutable state/command evidence | tenant + sequence |

所有表都带 `tenant_id`。D1 中金额和 64-bit 时间可以存 TEXT/INTEGER，但 codec 必须验证范围；
不能依赖 JavaScript number 无损读取超大金额。

## 10. Storage profiles

- `control`：mapping、idempotency、inbox/outbox、license/voucher、migration、audit；最低要求。
- `projection`：在 control 上增加 canonical snapshots，推荐默认。
- `catalog`：Polybill 同时作为 Product/SKU/Price 真源。

宿主可把业务订单保留在自己的 DB，只通过 `externalId` 和 application event 关联。Polybill
不会要求宿主复制所有表，也不会对宿主 schema 建 foreign key。
