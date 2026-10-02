# Polybill 设计文档索引

状态：架构基线，2026-08-25；实现与支付安全复核更新至 2026-09-06。当前 provider adapters 均为 experimental。

## 产品定义

Polybill 是一个 TypeScript billing orchestration library。它用稳定的领域模型管理
商品、SKU、价格、客户、结账、订单、支付、退款、订阅、授权与兑换，再通过 adapter
接入 Stripe、Dodo Payments、Polar、Creem、Waffo Pancake、Lemon Squeezy、Paddle
Billing 和 `x402-paysdk`。

“更换一个配置和凭据即可切换 provider”在以下范围内成立：

1. 新交易立即切换到目标 provider。
2. Polybill 自有的商品、SKU、价格意图、客户引用、授权和兑换数据保持不变。
3. 可迁移的 provider 目录数据通过计划、预演、执行和核对流程复制。
4. 旧 provider 上不可搬迁的支付凭据和活跃订阅进入双跑或官方协助迁移流程。

任何 SDK 都不能在没有支付机构参与的情况下复制卡 token、银行 mandate、MoR 法律关系、
历史税务发票或争议责任。Polybill 对这些差异返回显式迁移结果，不宣称虚假的无损迁移。

## 已冻结的架构决策

- 公共 API 只暴露 canonical domain，不把某家 provider 的状态或 ID 作为主键。
- 每个能力是 `native | emulated | unsupported`，并附带约束；不是一个含糊的布尔值。
- `Product` 描述商品，`SKU` 表示可售变体，`Price` 是不可变价格版本。
- 商品计价金额使用“十进制整数字符串 + ISO-4217 currency”，内部用 `bigint` 运算；链上结算
  另用 asset/network/decimals/atomic amount，并通过显式 quote 关联，禁止隐式把 USD 当 USDC。
- `test` 与 `live` 的凭据、映射、webhook secret 和数据完全隔离。
- webhook 路由统一为 `/webhooks/polybill/:provider`；如同一部署连接多个账户，可追加
  `/webhooks/polybill/:provider/:connection`。
- webhook 必须先校验 raw body，再持久化 inbox，最后异步归一化；通知不是支付最终性。
- Polybill 只要求一个小型 control-plane store，不接管宿主的用户表和业务订单表。
- license、entitlement、数字发卡与兑换由 Polybill 原生实现，provider 原生 license 只作为
  可选发行后端。
- 一期“发卡”指数字授权卡、礼品码或兑换券，不指 Visa/Mastercard 等金融卡发行。金融卡
  发行需要单独的合规产品和 adapter capability。
- x402 一期是一次性加密货币结算。订阅周期由 Polybill 调度时，仍需每期获得新的链上授权；
  不伪装成卡式自动扣款。
- Cloudflare Workers 是最低运行时基线；core 不依赖 Node.js built-in。
- Waffo 接入目标是 Waffo Pancake MoR (`@waffo/pancake-ts`)。Waffo PSP 是另一条产品线，
  后续可作为独立 adapter，不能共享“MoR”语义。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 功能、非功能需求、范围和验收标准 |
| [RESEARCH.md](./RESEARCH.md) | 官方资料、provider 能力矩阵、已知限制与待验证项 |
| [PAYMENT_REVIEW_2026-09-06.md](./PAYMENT_REVIEW_2026-09-06.md) | 支付安全复核、现行官方协议证据与恢复边界 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层、调用链、可移植性、最终性与运行时设计 |
| [MODULES.md](./MODULES.md) | monorepo 包结构、模块职责和依赖规则 |
| [DATA_MODEL.md](./DATA_MODEL.md) | canonical entities、状态机、表和索引 |
| [PROVIDER_CONTRACT.md](./PROVIDER_CONTRACT.md) | adapter SPI、能力协商、错误和幂等约定 |
| [POLAR_API_2026-10.md](./POLAR_API_2026-10.md) | Polar 2026-10 / 2027-01 版本契约、漂移检查与回滚 |
| [SUBSCRIPTIONS_2026-10.md](./SUBSCRIPTIONS_2026-10.md) | 八个平台的订阅机制覆盖、当前实现与待接入项 |
| [BILLING_WORKFLOWS.md](./BILLING_WORKFLOWS.md) | 异步订阅绑定、延期执行、精确费率与额度账本 |
| [PROVIDER_API_REVIEW_2026-10-02.md](./PROVIDER_API_REVIEW_2026-10-02.md) | 各家官方 API 与接入文档逐项复核、协议偏差与证据边界 |
| [WEBHOOKS.md](./WEBHOOKS.md) | 统一入口、签名、inbox、事件归一化和对账 |
| [MIGRATION.md](./MIGRATION.md) | 已有系统接入、provider 切换、双跑和回滚 |
| [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) | 现有系统的非侵入接入步骤和 cutback 操作 |
| [X402.md](./X402.md) | `x402-paysdk` 包装方式与链上最终性 |
| [SECURITY.md](./SECURITY.md) | 威胁模型、密钥、PII、license 和 SSRF 防护 |
| [TESTING.md](./TESTING.md) | 不依赖真实 webhook 的完整测试策略 |
| [PUBLIC_API.md](./PUBLIC_API.md) | facade、package 边界和公开成熟度说明 |
| [COMPATIBILITY.md](./COMPATIBILITY.md) | provider 能力、证据等级和 stable promotion gate |
| [OPERATIONS.md](./OPERATIONS.md) | webhook、队列、D1、密钥和迁移运维手册 |
| [RELEASE.md](./RELEASE.md) | 发布门禁、changeset 和 provider drift 流程 |
| [MILESTONES.md](./MILESTONES.md) | 里程碑、退出条件、风险和交付顺序 |

## 变更规则

实现与文档发生冲突时，先更新设计和迁移影响，再改代码。涉及 canonical schema、状态机、
provider capability、webhook 语义或存储兼容性的变更需要 changeset，并至少增加一个
contract test。未经文档记录，不得把 `emulated` 静默改为 `native`，也不得把
`unsupported` 变成无操作成功。

## 尚待产品确认但不阻塞一期设计

- “发卡”是否未来包含金融卡发行；本设计仅覆盖数字码。
- 是否提供 Polybill 托管控制面；当前 SPI 同时支持 BYO store 和未来托管模式。
- 第一版是否承诺用量计费。领域模型预留 meter/usage，里程碑在基础订阅稳定后启用。
- Waffo 是否还需要接 PSP 产品线；当前按 Pancake MoR 实现。
