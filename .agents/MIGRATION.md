# 非侵入接入与 Provider 迁移

## 1. 目标和现实边界

迁移目标是让新交易快速转入 Polybill，同时保留旧系统稳定运行，并逐步建立 canonical mapping。
迁移不要求重写宿主 DB，也不伪造支付凭据可移植性。

可自动迁移：catalog intent、SKU/price mapping、customer external references、历史只读
order/payment/subscription projection、Polybill-owned entitlement/license/voucher。

通常不可直接复制：PAN/token、wallet token、bank mandate、MoR 订阅授权、历史税票、争议责任。
只有源和目标 provider 的官方迁移项目明确确认时，才把 payment method 标记为 migrated。

MoR -> PSP/settlement network 不是单纯 adapter replacement。planner 必须比较 seller of record、
tax collection/invoice 和 dispute responsibility；责任发生变化时生成 blocking
`legal_responsibility_change`，直到宿主的合规 owner 提供显式 policy/acknowledgement。

## 2. Adoption modes

### Mode 0: Observe-only

- 保留原 SDK 创建支付和订阅。
- 把原 webhook 额外配置到 Polybill unified endpoint，或定期 read-only import。
- 建立 external mapping 和 canonical projection，不触发 entitlement/fulfillment。
- 用于评估字段缺失、状态映射和历史数据质量。

### Mode 1: Shadow-read

- 业务写入仍走旧系统。
- Polybill 同时从 provider API 读取并与宿主状态比较。
- 产生 drift report，不做 shadow mutation，避免双收费/双订阅。

### Mode 2: New-sales cutover

- 新 checkout/order 走 Polybill；旧订阅继续由源 provider 续费。
- webhook/reconciliation 同时连接新旧 connection。
- customer 通过宿主 `externalId` 合并展示，payment method 不跨 connection 复用。

### Mode 3: Cohort dual-run

- 按 tenant、plan、地区或 customer cohort 选择 connection。
- 一名 customer 的同一 subscription 只能有一个 billing owner。
- routing decision 持久化，重试不能重新随机选 provider。

### Mode 4: Full control

- Polybill 创建所有新交易并持有 control-plane projections。
- 旧 provider 只保留法定历史、未结束争议和无法迁移的 subscriptions。

## 3. Minimal database contract

最低接入只增加 `polybill_*` control tables：connection、mapping、idempotency、inbox/outbox、
migration checkpoint、audit，以及使用 license/voucher 时对应表。

宿主提供三个可选 bridge：

```ts
interface HostIdentityBridge {
  resolveCustomer(external: HostCustomerRef): Promise<CustomerId | undefined>;
}

interface HostOrderBridge {
  findOrder(externalId: string): Promise<HostOrderSnapshot | undefined>;
  applyBillingEvent(event: CanonicalBillingEvent): Promise<void>;
}

interface HostCatalogBridge {
  listCatalog(cursor?: string): Promise<Page<HostCatalogItem>>;
}
```

这些 bridge 不允许 migration library 自行写任意宿主表。宿主在 transaction 中消费 outbox
并按 canonical event ID 幂等更新自己的 order/user entitlement。

## 4. Migration lifecycle

```text
analyze -> plan -> dry_run -> approved -> applying -> verifying -> cutover
   |         |        |          |           |            |
   +------ blocked   failed <-----+-------- rollback <-----+
```

### Analyze

- 读取 provider account/environment、API version 和 capability。
- 分页扫描 products/prices/customers/subscriptions，不执行写入。
- 统计数据量、currencies、状态、payment methods、tax modes、unknown enums。
- 将 email/姓名等 PII 只在受控内存中用于匹配，报告使用 hash/计数。

### Plan

每个 item 给出：source ID、canonical ID、target action、mapping、losses、dependencies、
required human action、rollback class。

```ts
type MigrationAction =
  | "map_existing"
  | "create_target"
  | "update_target"
  | "archive_target"
  | "keep_source_pinned"
  | "request_reauthorization"
  | "provider_assisted"
  | "manual_review";
```

计划包含 source/target capability snapshot hash，执行前发生变化则要求重新 approve。

### Dry-run

- 运行完整转换和 schema validation。
- 允许 target read/check，不允许 create/update/archive。
- 生成 deterministic diff；同一输入重复运行输出相同 plan item keys。

### Apply

- 按 dependency graph：Product -> SKU/Price -> Customer mapping -> future checkout routing。
- 每个 item 有独立 idempotency key、state、attempt 和 evidence。
- 支持 checkpoint/resume；进程退出后不从头重复创建。
- 默认 bounded concurrency，按 provider rate limit 分桶。

### Verify

- 通过 target `get(id)` 而不是仅 list read-after-write。
- 比较金额、currency、interval、tax behavior、trial、active/archived 和 metadata link。
- 历史 totals 只做对账，不要求 target 复制不可变 source ledger。

### Cutover and cutback

- routing table/feature flag 是唯一切流点。
- 切流前冻结 source 新 catalog write 或启用 drift monitor。
- cutback 只影响新 checkout；已经在目标创建的 payment/subscription 不能假装撤回。
- rollback 执行 archive/deactivate，而不是删除含财务历史的对象。

## 5. Identity and conflict rules

自动匹配优先级：

1. 已存在的 Polybill/provider mapping。
2. 由 Polybill 写入的 stable external reference/metadata。
3. 宿主明确提供的 external ID mapping。
4. email 只能生成 candidate，不自动 merge；共享邮箱、大小写和变更会误合并。

冲突必须持久化并人工/策略解决：一个 external ID 指向多个 customer、一个 target object 被多个
canonical entity 占用、currency/interval 不一致、target 存在同名不同价。

绝不按 product name、customer email 或金额单独执行 destructive merge。

## 6. Active subscription strategies

### A. Provider-assisted credential migration

仅当源、目标和 card vault/processor 明确支持时使用。Dodo 官方文档说明目前只支持 card token，
不支持 Apple Pay/Google Pay 等 wallet token，并需 Solutions Engineer。流程：

1. 完成新销售切流。
2. 锁定 export/import cohort 与 cutoff time。
3. provider 安全通道传 token；Polybill 不接触 card data。
4. 导入 customer、plan、next billing date，建立 mapping。
5. 在目标成功验证后取消源 schedule；逐 customer 对账。

### B. Dual-run until natural churn

旧 subscription 保持 source-pinned，新 signup 走 target。统一 customer view 聚合多个 connection，
直到旧订阅取消/到期。风险最低，也是 Waffo/Creem 官方迁移文档的现实路径。

### C. Reauthorization campaign

创建目标 checkout/portal link，让 customer 重新输入支付方式。只有目标 subscription 激活后才
取消 source；使用 deterministic migration token 防止双创建。若重授权失败，source 保持不变。

## 7. Catalog conversion

- Product 和 Price 分离，即使 provider 把价格嵌入 Product/Variant。
- provider 的 immutable price 变化映射为新的 Polybill Price version。
- recurring interval 只有 exact match 才自动迁；`3 months` 不能默认等于 quarter，除非 target
  明确支持 count=3。
- currency、zero-decimal exponent、tax inclusive/exclusive、trial 和 usage meter 必须逐字段比较。
- provider 不支持的 discounts/benefits 变成 loss report 或 Polybill entitlement，不修改应付金额。

## 8. Existing code transition

推荐改动顺序：

1. 将现有 provider ID 包装在 repository/adapter，停止在业务层继续扩散。
2. 引入 Polybill webhook observe-only 与 reconciliation，建立 mapping。
3. 业务权限改为消费 canonical event/entitlement projection。
4. 只替换 checkout create 调用；旧查询在过渡期继续 source read。
5. 替换 customer portal、subscription mutation 和 refund。
6. 开启 new-sales cutover，最后处理历史订阅。

不提供伪装成完整 Stripe SDK 的 drop-in facade；那会把 Stripe 语义永久写进 Polybill。可提供窄的
codemod/migration helper 把常见调用转换为 canonical command，并输出未转换清单。

## 9. Webhook-independent import

迁移不依赖 provider 重发历史 webhook：

- 通过 list/get API 扫描 authoritative resource。
- 使用 `updated_at + cursor + overlap window` 或 provider cursor 保存 high-water mark。
- 每轮 overlap 重读少量对象并按 snapshot hash 去重。
- provider 不支持按更新时间 list 时，分片 full scan 并保存 page cursor。
- importer 只构建 projection/mapping，不重发 `payment.succeeded` 给宿主，除非显式选择
  `emitHistoricalEvents`，且历史事件 namespace 与实时事件分开。
- provider adapter 的可选只读 migration port 提供 source scanner；migration toolkit 绑定显式
  tenant/connection/environment context，并在每页保存 checkpoint。cursor 只作为 provider-specific
  opaque state 返回，adapter 必须以固定 base URL 重建下一页请求，不能跟随 provider payload 中的
  任意 URL。

## 10. Migration verification report

报告至少包含：

- total/scanned/mapped/created/skipped/failed/manual counts。
- capability losses 和 provider-pinned workflows。
- seller of record、tax/invoice/dispute responsibility changes 与 acknowledgement 状态。
- 未迁 active subscriptions、payment methods、discounts、licenses 和 disputes。
- 每种 currency/interval/tax behavior 的 source-target totals。
- duplicate/conflict/unmapped lists（PII redacted）。
- cutover readiness 与 blockers。

迁移只有在 blocking conflicts 为 0、目标目录核对通过、webhook/reconciliation 健康且 cutback
开关可用时进入 `ready`。
