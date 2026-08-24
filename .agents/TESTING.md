# 测试与验证策略

## 1. 目标与原则

测试必须在没有第三方账户、没有公网地址、没有 provider 主动发送 webhook 的环境中证明核心
正确性。真实 sandbox 只用于发现 API 漂移和验证少量端到端兼容性，不作为 CI 通过的前提，
也不作为支付最终性的唯一证据。

测试优先证明以下不变量：

- 相同 canonical command 在具有相同 capability 的 provider 间保持业务语义。
- MoR/PSP/settlement responsibility 不被 checkout capability 掩盖；不兼容 commercial policy 在
  transport 前失败。
- test/live、tenant、connection、external ID、secret 和幂等记录绝不串用。
- 金额、币种、周期、税模式、状态和迁移损失不会被静默转换。
- webhook 缺失、重复、延迟、乱序或无法识别时，系统仍可通过 reconciliation 收敛。
- 外部请求超时后不会盲目重复收费；不确定结果保持 `outcome_unknown`，直到 read-back。
- license 激活、单次兑换和 inbox/idempotency claim 在并发下至多成功一次。
- 默认发布物可在 workerd/Cloudflare Workers 运行，且不依赖 `node:*`。

## 2. 测试层次

| 层次 | 运行环境 | 覆盖内容 | 是否需要第三方 |
| --- | --- | --- | --- |
| Static | TypeScript、ESLint、API report、bundle scan | 类型、依赖方向、exports、Node import | 否 |
| Unit/model | Vitest + virtual clock | 纯领域函数、状态机、money、codec、mapper | 否 |
| Conformance | adapter/store contract runner | 所有 adapter 和 store 的统一语义 | 否 |
| Protocol | scripted `fetch` server + raw fixtures | HTTP 编码、错误、签名、分页、重试 | 否 |
| Integration | workerd/Miniflare + D1/Queue/DO | 事务、队列、统一 webhook、reconcile | 否 |
| Sandbox smoke | provider test/sandbox account | 上游 API、凭据和 schema 漂移 | 可选 |

PR 的 required checks 只包含前五层。sandbox job 采用 nightly/manual、按 provider 独立标记，
缺少 secret 时明确 skip，不能把“没有账号”报告为成功执行。

## 3. 确定性测试基础设施

`@polybill/testing` 提供以下组件：

```ts
createFakeProvider(options): FakeProvider
createScriptedHttpProvider(script): { fetch: typeof fetch; requests: RequestLog }
createTestConnection(overrides): ProviderConnection
createVirtualClock(start): VirtualClock
createDeterministicIds(seed): IdGenerator
signWebhookFixture(provider, body, key, options): SignedFixture
runAdapterConformance(factory, manifest): void
runStoreConformance(factory): void
```

`createFakeProvider()` 实现 canonical provider 行为，用于跨 provider 的 application 测试；它不
假装属于某一家 provider。`createScriptedHttpProvider()` 按精确脚本返回 provider 风格 HTTP
response，用来验证各 adapter 的协议翻译。两者必须分开，避免 canonical fake 掩盖真实协议差异。

脚本化 transport 是一个注入的 `fetch` handler，不要求监听 TCP port，因此同一套测试可在 Node
和 workerd 中执行。每一步声明 method、URL、headers、结构化 body matcher、response、延迟或
故障，并记录是否有未消费/额外请求。测试结束仍有未消费步骤或意外请求时失败。

所有随机 ID、时间、退避和网络结果可注入；snapshot 不得包含真实当前时间、随机 secret 或
未排序对象。涉及随机安全性的生产函数另做 entropy/format 检查，测试不能让确定性 RNG 进入
production composition root。

## 4. Fixture 管理

fixture 分三类，存放在 `fixtures/providers/<provider>/<api-version>/`：

1. `http/`：请求与响应 golden fixture，覆盖目录、客户、checkout、订阅、退款和 list/get。
2. `webhooks/`：未经解析的 body bytes、必要 headers 和 expected canonical events。
3. `errors/`：认证、权限、限流、冲突、无效 schema 和 provider 特有错误。

每个 fixture 旁保存 metadata：provider、API version、test/live 语义、来源 URL 或已脱敏 sandbox
capture、capture/review 日期、payload SHA-256、预期 codec version。fixture 禁止包含 API key、
签名 secret、完整邮箱/地址、支付凭据、license 明文和可关联真实用户的数据。

fixture 更新必须经过 review；批量录制不能直接覆盖 golden output。provider API version 升级时，
先用旧 fixture 全量回放，再新增新版目录并输出 schema/status/capability diff。

## 5. 领域与类型测试

### Money 和 catalog

- minor-unit 字符串的零值、前导零、负数、超大值、非十进制字符和 `bigint` 边界。
- ISO-4217 exponent 不是统一两位；JPY、USD 和三位小数币种使用明确 currency metadata。
- `Money` 与 `AssetAmount` branded type 不可互换；USD minor unit 不被直接当作 USDC atomic amount。
- 加总、比例折扣、税、proration、部分退款和 rounding policy 的守恒性质。
- Product/SKU stable key 唯一性；Price 更新必须生成新版本，历史 OrderLine snapshot 不变。
- ad hoc price 的 native、temporary-object emulation、lossy opt-in 和 unsupported 分支。

### 状态机

- Payment、Refund、Subscription、Grant、License、Voucher 的所有合法转移。
- 非法逆转返回稳定错误，未知 provider 状态保留 raw evidence 而不强制 cast。
- `cancelAtPeriodEnd` 保持当前 subscription status，并单独记录 scheduled change/access window。
- payment status 与 fulfillment/entitlement 状态独立；重复事实不重复 grant/revoke。

使用 `fast-check` 或等价 property runner 生成 operation sequence，并以一个简单 reference model
比较结果。至少验证：退款累计不超过付款、voucher 剩余次数不为负、同一 payment attempt 不从
终态返回处理中、事件回放幂等、金额序列化往返无损。

### Compile-time contract

- `tsc --noEmit` 开启 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`。
- 用 `expectTypeOf`/类型 fixture 验证 branded ID 不可互换、capability union 穷举、public input
  不接受 `number` 金额或 provider raw object。
- API report 阻止 internal deep export、意外 `any` 和 provider-specific 类型泄漏到 facade。

## 6. Adapter conformance suite

每个 provider adapter 必须提交 capability manifest。runner 只运行其声明能力，但会反向验证：
声明 `unsupported` 的操作必须在发送 HTTP 前失败，声明 `native` 的操作必须存在成功和失败协议
测试，声明 `emulated` 的操作必须返回 strategy、fidelity 和 portability warning。

共同场景至少包括：

- test/live base URL 和 credential resolver；错环境 external ID 在 transport 前被拒绝。
- catalog create/read/archive、immutable price mapping、multi-item 与 ad hoc price constraints。
- customer create/update/read/portal；PII patch 不把缺失字段错误地发送为 `null`。
- hosted checkout、一次性支付、基础 subscription、取消、数量变更和 proration capability。
- 全额/部分退款及累计上限；provider 不支持部分退款时不降级为全额。
- request codec、response runtime decode、unknown enum、额外字段、缺字段和无效 JSON。
- native idempotency header/body reference；同 key 不同 payload 冲突；timeout 后 query-before-create。
- pagination cursor 包装、空页、重复 item、最终一致 list 后的 `get` read-back。
- 429 `Retry-After`、可重试 5xx、不可重试 4xx、deadline/abort、connection 级 rate-limit 隔离。
- provider error 到稳定 error code 的映射，以及 message/evidence 的脱敏。
- `CommercialTermsSnapshot` 的 account/region/expiry 约束；MoR-required policy 不能路由到 PSP 或
  x402，责任变化必须进入迁移 blocker。

capability manifest 与文档中的矩阵由一个结构化源生成或比较；adapter 不能只靠 Markdown 声称支持。

## 7. 无外部 webhook 的测试

### 独立签名向量

每个 provider 保存 valid、body-tampered、signature-tampered、old/future timestamp、wrong secret、
key rotation 和多签名向量。签名输入必须是原始 bytes，包括空格、换行和 Unicode 编码差异。

测试 fixture signer 与 production verifier 不共享 canonical-string helper，防止同一个错误让测试
假通过。HMAC/RSA 结果使用 Web Crypto、官方 helper 或命令行参考实现交叉核对；Waffo 使用固定
测试 RSA keypair，Standard Webhooks 类 provider 使用其规定的 base64/消息格式。生产 fixture
不含真实 endpoint secret。

`signWebhookFixture()` 仅是测试便利函数；至少一组不可动态重算的 known-answer vector 会固定
expected signature。真实 sandbox capture 只作为可选补充。

### Handler 和 inbox

- 路由 allowlist、缺失/歧义 connection、错误 method/content type、256 KiB 上限。
- raw body 只读取一次，先验签后 JSON decode；验签失败不写 inbox。
- test/live secret、active/previous key 和 connection resolution 隔离。
- 首次事件安全写 inbox 后 ack；inbox 暂时失败返回 5xx；重复 applied 返回 2xx。
- 重复 processing 不产生第二个 queue message；未知 event 保存并 2xx。
- queue consumer crash、lease expiry、retry、dead letter、人工 replay 和 outbox 幂等。
- 乱序/同 timestamp 冲突不覆盖新 projection，并触发 authoritative read-back。

所有场景直接构造 Web `Request` 调统一 handler，无需公网 URL。框架 wrapper 只补一组 raw-body
传递测试，业务矩阵不在 Hono/Next/Node 重复执行。

## 8. Reconciliation-first 端到端场景

核心 E2E 故意不发送 webhook：

```text
create canonical command
  -> scripted provider 接受写入但丢失 response 或 event
  -> local state = pending/outcome_unknown
  -> reconciler list/get authoritative resource
  -> mapper + projection + outbox
  -> canonical state converges exactly once
```

必测变体：

- checkout/payment 已成功但 create response 丢失，按 idempotency/reference 恢复，不二次创建。
- subscription 在 provider 取消但 webhook 永不送达，cursor poll 修正 projection。
- webhook 先到、API list 延迟可见；reconciler 不把较新状态回退。
- cursor page 中途失败，checkpoint resume 使用 overlap window，重复页不重复 side effect。
- provider 删除/归档、mapping 缺失、金额不一致和未知远端状态只产出 diff，按 policy 决定修复。
- 高风险 `payment.succeeded` 由 provider GET/receipt 提升 evidence finality 后才发 entitlement。

这组测试是所有 stable adapter 的 release gate，即使该 provider 提供 webhook simulator。

## 9. Store、并发与故障注入

`runStoreConformance()` 对 memory、D1 和后续 Postgres 使用相同语义测试：

- tenant/connection/environment 复合键隔离和双向 mapping 唯一性。
- idempotency claim、相同 payload replay、不同 payload conflict、lease takeover 和 saved result。
- inbox claim/dedupe/state transition；outbox 至少一次 publish 与 consumer dedupe。
- snapshot optimistic version；migration checkpoint 单调推进。
- license activation CAS；voucher redeem 的扣减与 ledger insert 原子提交。
- rollback/transaction failure 不留下半套 mapping、snapshot 或 grant。

并发测试使用至少两个独立 store client/Worker isolate，不只在一个 JavaScript event loop 调
`Promise.all`。对 D1 运行条件更新争用；需要严格串行的 voucher batch 可通过 Durable Object
执行。100 个并发请求兑换一个单次码时，必须恰好一个成功，重试相同 idempotency key 返回同一
redemption。

fault injector 可在 `before_send`、`after_send_before_response`、`before_commit`、
`after_commit_before_publish`、queue ack 前后注入 timeout/crash。每个 phase 断言可恢复状态、
不会重复远端 mutation，并最终可由 retry/reconcile/outbox 收敛。

## 10. License、voucher 与 entitlement

- key/code 至少 128-bit entropy 的格式检查、normalization、checksum 和 HMAC digest lookup。
- 明文只在 issuance 返回；日志、error、snapshot 和数据库 dump matcher 中不得出现。
- active/expired/suspended/revoked、activation limit、重复 instance 和 deactivate/reactivate policy。
- provider-native license mirror 失败不撤销 Polybill truth，进入可重试 sync 状态。
- voucher campaign/time/customer/SKU constraints、部分余额、多次使用、过期和 revoke。
- payment/refund/subscription 事件重复、乱序时 grant/revoke 只执行一次；grace period 使用虚拟时钟。
- AES-GCM recoverable value 的 key rotation、错误 AAD、tamper 和旧 key read/new key write。

安全随机性测试只验证长度、格式、碰撞 sanity 和使用正确 CryptoPort，不以统计测试替代密码学
设计审查。

## 11. Migration 测试

每个 importer 使用离线 API fixture 和宿主 export fixture 执行：

- `analyze`/`plan`/`dry-run` 零外部写入；使用 transport request log 证明。
- 重复 `apply`、进程中断 resume 和 overlap scan 不重复创建目标对象。
- Product/Variant 嵌套与 Product/SKU/Price 分离、currency exponent、interval、tax behavior 转换。
- customer email 仅生成候选，不自动 merge；冲突进入 durable report。
- active subscription 被正确分类为 migrated、reauthorize、dual-run 或 source-pinned。
- MoR -> PSP/x402 生成 seller/tax/invoice/dispute responsibility blocker，acknowledgement 可审计。
- `verify` 比较 source/target totals、mapping 和 capability losses；最终一致 list 使用 read-back。
- cutback 切回 routing，不删除财务历史；只 archive 本次创建且确认无依赖的目录对象。
- 历史 import 默认不发送实时 `payment.succeeded`/grant side effect。

构造一个现有 Stripe 风格宿主 repository 作为兼容性 fixture，证明宿主 user/order 表无需改 schema，
只通过 external ID、mapping 和 canonical event bridge 渐进接入。

## 12. x402 测试

- 直接调用 `x402-paysdk/merchant` 的公开验证 API 和 canonical fixture，不复制协议实现。
- fake gateway/facilitator 覆盖 create ref、settle、response lost、receipt recovery 和 refund 条件。
- deterministic test signer 覆盖 trusted/untrusted signer、kid、content hash 和 receipt 篡改。
- expected tuple 逐项验证 network/chain、asset、atomic amount、payTo、payer、ref、invoice 和 expiry。
- settlement quote 绑定 Order Money、asset tuple 和有效期；过期/错币种/错 decimals/隐式 1:1 转换被
  拒绝，显式 fixed policy 与 quote-provider policy 分别测试。
- fake chain/RPC 覆盖 0/不足/足够 confirmations、RPC timeout、failed tx、reorg 和重复 tx hash。
- notify 缺失时由 history/reconcile 恢复；valid notify 在 chain 未确认前不得标记 succeeded。
- 同一 tx hash 支付两个 Order 被唯一约束拒绝；nonce 由共享 D1/DO store 原子 claim。
- recurring request 返回每周期重新授权 workflow，不得产出 reusable mandate。
- 对实际 `x402-paysdk` 发布 tarball 运行 workerd bundle；transport 必须可注入 timeout/fault，测试
  禁止通过替换全局 `fetch` 制造隔离假象。

可选测试网 job 只验证当前 gateway/network 兼容性，不让资金操作成为普通 CI 的一部分。

## 13. Cloudflare 与发布验证

workerd suite 至少包含：

- Worker 中创建 fake checkout、接收 signed fixture、D1 inbox claim、Queue consume、outbox publish。
- 两个 isolate 并发 redeem license/voucher；scheduled reconciler 从断点继续。
- Service Binding 或 injected fetch 访问 scripted provider，不使用 Node socket/server。
- D1 migration 从上一发布版本升级和空库初始化；失败 migration 的恢复路径。
- Queue duplicate/redelivery、consumer exception、dead-letter 和 CPU/time limit 下的分批处理。

发布 gate：

- 对所有 package 和条件 export 执行 Worker bundle，扫描 `node:`、`fs`、`net`、`tls`、
  `child_process` 和隐式 Node polyfill。
- `publint`、`attw`、pack allowlist、ESM import smoke、Node 20+ smoke、Miniflare smoke。
- 检查 package tarball 不含 fixture secret、`.env`、raw captures、private key 或内部 source map。
- core/provider 默认入口在没有 `nodejs_compat` 时可加载；Node 优化只能在显式 `/node` subpath。

## 14. 安全负向测试

- webhook timing-safe comparison、body confusion、重复 header、多值 signature 和 Unicode/JSON 重排。
- URL allowlist、HTTPS、userinfo、redirect、DNS/private address、oversized path/query 和 SSRF 输入。
- metadata prototype keys、深度/大小限制、无效 UTF-8、压缩炸弹和 oversized provider response。
- tenant/connection ID 猜测不能读取 mapping/evidence；cursor 篡改不能改变 provider query。
- log/error/trace 使用 canary secret、email、license 和 signature 扫描，任何泄漏使测试失败。
- dependency/bundle audit 和 provider schema drift report；发现变化先降级 capability 或阻断发布。

## 15. CI 分组与退出条件

建议脚本契约：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:workerd
pnpm test:migration
pnpm test:security
pnpm build
pnpm check:packages
pnpm check:worker-bundle
```

PR 使用受影响包选择加一组全仓 typecheck/依赖检查；main/release 执行所有离线 suite。测试分片时
provider conformance 按 adapter 分片，store/workerd 不得因执行较慢而从 required gate 移除。

发布 stable adapter 的最低证据：所有 native capability 有协议成功/失败场景、所有 webhook 安全
向量通过、reconciliation-first E2E 通过、workerd bundle 通过、fixture 来源和 API version 已记录。
行覆盖率只作趋势指标；关键状态机、capability 分支和故障 phase 要求显式场景，不能用总覆盖率
替代。flaky test 必须隔离并创建修复事项，不能自动重跑到绿后视为通过。

## 16. Sandbox 兼容性作业

有凭据时，每家 provider 运行最小、可清理的 smoke：连接检查、创建/读取测试目录对象、创建测试
checkout、调用官方 webhook simulator/CLI（若有）、读取权威状态并 archive 测试对象。Stripe test
clock、Lemon Squeezy test event、Paddle simulator 等只补充相应 adapter 的上游验证。

job 使用专用 test account、唯一 run prefix、金额上限和 cleanup manifest；禁止 live credential，
environment guard 在任何写请求前验证 base URL/account。不能创建可运行产品的 provider 仍可凭
离线 fixture、签名向量、scripted protocol 和 reconciliation suite 达到 experimental；提升 stable
前至少需要一次由维护者记录的只读/最小 sandbox compatibility verification，或明确发布为
`experimental` 并列出未验证 capability。
