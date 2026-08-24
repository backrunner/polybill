# 需求与验收基线

## 1. 目标

为 TypeScript 应用提供一个 provider-neutral billing API，使宿主应用的业务逻辑依赖
Polybill ID、状态和事件，而不是依赖 Stripe、Dodo、Polar、Creem、Waffo、Lemon
Squeezy、Paddle 或 x402 的对象结构。

## 2. 功能需求

### FR-1 Provider connection

- 支持 `stripe | dodo | polar | creem | waffo | lemonSqueezy | paddle | x402`。
- connection 必须显式指定 `environment: "test" | "live"`。
- 同一进程可连接多个 provider、多个商户账户和两个环境。
- 凭据通过函数或 secret binding 延迟读取，不要求进入普通配置对象的可序列化部分。
- 初始化时返回经过版本化的 capability snapshot，并能执行只读连通性检查。

### FR-2 Catalog、SKU 与价格

- 创建、读取、更新、归档 Product；Product 不承载直接收费语义。
- 一个 Product 可有多个 SKU；SKU 具有稳定业务键、属性、税类和 entitlement policy。
- Price 采用不可变版本，支持一次性、周期、按量、阶梯、席位、免费和自定义金额意图。
- 支持 provider catalog 的 push、pull、diff、dry-run、conflict report 和 external mapping。
- provider 不允许 API 创建目录时，必须返回人工步骤或导入计划，不能假装已创建。
- ad hoc price 在调用前完成能力检查；可按配置使用 provider 原生 inline price、临时目录
  对象，或明确拒绝。

### FR-3 Customer

- 以 Polybill customer ID 和宿主 `externalId` 识别客户。
- 管理姓名、邮箱、账单地址、税号引用和 provider customer mappings。
- PII 更新支持局部 patch，删除采用 tombstone；不承诺跨 MoR 删除法定留存记录。
- 返回 customer portal URL 时标明 provider、有效期和允许操作。

### FR-4 Checkout、订单和支付

- 支持 hosted checkout，允许 adapter 扩展 embedded/custom checkout。
- 支持一个或多个 line item、数量、折扣、税模式、metadata、success/cancel URL。
- 创建 Order、Payment、Refund、Dispute 的 canonical snapshot 和不可变审计事件。
- checkout 前解析 commercial terms；Order 固化 seller of record、tax/invoice responsibility 和
  commercial terms evidence，不能在切换 provider 时静默把 MoR 责任转给宿主。
- 支持全额与部分退款、失败原因、requires-action 和异步支付方式。
- 每个写操作接受或生成 idempotency key。
- 订单支付状态和业务 fulfillment 状态严格分离。

### FR-5 Subscription

- 支持创建、查询、试用、取消、取消撤销、暂停、恢复、升级、降级、数量调整和 proration
  policy；provider 不支持的动作在调用前失败。
- 统一状态不得吞掉 provider 原状态；raw status 保存在 provider snapshot。
- `cancelAtPeriodEnd`、立即取消、访问截止时间和账单截止时间分别建模。
- 支持周期性 reconciliation，修复漏 webhook 和乱序事件。
- 迁移结果必须区分 payment method 已迁移、需用户重新授权、旧 provider 双跑。

### FR-6 License、entitlement、数字卡与兑换

- Polybill 原生生成、导入、分配、激活、校验、停用、暂停、吊销和过期 license key。
- 支持激活次数、设备实例、租户/用户绑定、离线签名 token 的可选扩展。
- 支持批次发行数字卡/兑换码、单次或多次兑换、余额/权益 grant、有效期和活动限制。
- 兑换必须原子化，支持幂等请求和审计；同一单次码在并发下最多成功一次。
- provider 原生 license 可镜像，但 Polybill-owned entitlement 是可移植真源。

### FR-7 Discount、credit 与 usage

- 统一固定金额、百分比、有效期、次数、适用 SKU/customer 和 redemption constraint。
- provider 不支持折扣时，可选择 Polybill voucher 改发 entitlement；不得在未改变应付金额时称为
  “支付折扣”。
- 预留 meter、usage event、credit ledger 和 aggregation；usage event 需要幂等键。
- 金额 credit 与产品内虚拟 credit 分开建模。

### FR-8 x402

- 使用已发布的 `x402-paysdk` 公共入口，不复制其协议、签名和 receipt 逻辑。
- 将 PaymentRef/Order、交易 hash、signed receipt 和 chain verification 映射为 canonical
  Payment evidence。
- canonical Order 的 ISO-4217 计价金额与 USDC 链上 atomic settlement 分开保存；通过有过期时间的
  quote 或商户显式固定策略解析，禁止默认假设 USD 与 USDC 永远 1:1。
- webhook/notify 只触发同步；成功必须有已验证 receipt 和满足策略的链上 finality。
- v1 不宣称原生自动续订、退款到卡或支付凭据迁移。

### FR-9 Webhook 与事件

- 统一路径 `/webhooks/polybill/:provider`，可选 connection path segment。
- 对 raw body 验签、限制 body size、验证时间窗并隔离 test/live secret。
- inbox 在任何业务 side effect 前按 provider delivery ID 或经过规范定义的 raw-body digest 去重并
  持久化；重复请求返回 2xx。
- 归一化事件具有稳定 schema version，并保留可审计的 provider evidence reference。
- 处理未知 event type 时保存、告警、2xx，不因 SDK 尚未认识新事件造成 provider 重试风暴。
- 提供 polling/reconciliation 作为 webhook 缺失时的可靠路径。

### FR-10 迁移与嵌入

- 支持 `observe-only`、`shadow-read`、`new-sales-cutover`、`dual-run`、`full-control` 五种模式。
- 不要求宿主修改用户表或订单表；只要求实现 Store ports 或使用官方 store adapter。
- importer 可从 provider API 和宿主导出数据建立 Polybill ID/mapping，不重放业务副作用。
- 所有迁移具有 analyze、plan、dry-run、apply、verify、rollback/cutback 阶段。
- 支持按 customer/cohort 切流和 kill switch。

## 3. 非功能需求

### NFR-1 Runtime portability

- 核心包须在 Node.js 20+、Cloudflare Workers 和 workerd/miniflare 运行。
- core 和 provider HTTP adapters 仅依赖 Web 标准 API：`fetch`、`URL`、`Headers`、
  `Request`、`Response`、`TextEncoder`、Web Crypto 和 timers。
- Node-only vendor SDK 必须隔离在可选包；Cloudflare 路径不得依赖 `nodejs_compat` 才能工作。
- 发布前对 worker bundle 执行 `node:*` import scan 和 Miniflare smoke test。

### NFR-2 Type safety

- TypeScript `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`。
- public input/output 使用 schema runtime validation；不得用无边界 `any`。
- ID、currency、minor amount、digital-asset atomic amount、ISO datetime 和 idempotency key 使用
  branded types；两种 amount 不能互换。
- provider payload 在验签后仍视为 `unknown`，通过版本化 schema 解码。

### NFR-3 Reliability

- 所有外部写操作可幂等重试；默认只重试网络错误、429 和明确的 5xx。
- webhook handler 的同步工作限于验签、inbox 写入和 ack，目标 p95 小于 1 秒。
- 使用 outbox/queue 处理业务事件；失败进入带证据的 dead-letter 状态。
- 任何本地状态都可由 provider API、x402 receipt/chain 和 audit log 重建或核对。

### NFR-4 Security and privacy

- secret 不进入错误、日志、telemetry、snapshot 或测试 fixture。
- raw webhook 受大小限制，敏感字段加密或最小化保存，并设置 retention。
- license key 只保存 keyed digest；确需再次显示时用 envelope encryption 保存密文。
- success/cancel/portal/webhook URL 经过协议、host 和长度校验；服务端回调防 SSRF。
- tenant、connection 与 environment 是所有存储键和查询的强制维度。

### NFR-5 Compatibility and evolution

- public schema、event schema、store schema 和 adapter SPI 各自版本化。
- minor release 不改变 canonical 状态含义；破坏性变化遵循 semver 和 migration guide。
- provider API version 固定并记录；升级须运行旧 fixture 回放和新版本 contract suite。
- 单个实现文件目标不超过 400 行；超过 600 行必须拆分或记录例外。

## 4. 一期边界

一期必须实现一次性支付、基础订阅、客户、商品/SKU/固定与 ad hoc 价格、退款、webhook、
reconciliation、license/兑换、迁移 control plane 和 x402 一次性结算。

以下能力进入扩展 milestone，而不是在 v1 中伪装为已统一：复杂 usage billing、marketplace
split/payout、线下 POS、实物物流、金融卡发行、跨 provider 争议搬迁、已保存支付凭据的无协助
复制。

## 5. 验收标准

- 同一业务测试套件至少在 fake provider、Stripe sandbox 和另外一家 MoR sandbox 通过。
- 修改 connection 配置后，新订单无需修改业务代码即可由另一个支持相同 capability 的
  provider 创建。
- 若目标 provider 不满足调用者的 MoR/tax/invoice policy，切换在远端请求前返回 capability diff，
  不能以“支付可用”代替商业责任兼容。
- 所有 adapter 通过 capability contract、golden fixture 和 webhook security tests。
- CI 不需要任何第三方账户或公网 webhook；真实 sandbox 测试为可选 nightly/manual job。
- Cloudflare Worker 示例在 Miniflare 中完成 checkout create mock、webhook ingest、queue
  consume 和 license redeem。
- provider 不支持的能力返回稳定 `unsupported_capability`，并包含可执行替代方案。
- 迁移 dry-run 不产生外部写入；重复 apply 不重复创建对象；verify 输出逐项差异。
