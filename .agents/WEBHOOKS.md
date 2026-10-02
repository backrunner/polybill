# 统一 Webhook 与事件管道

## 1. Route contract

Polybill 暴露一个逻辑入口：

```text
POST /webhooks/polybill/:provider
POST /webhooks/polybill/:provider/:connection
```

`provider` 使用固定 allowlist：`stripe`、`dodo`、`polar`、`creem`、`waffo`、
`lemon-squeezy`、`paddle`、`x402`。它不是任意 URL 片段，也不从 body 推断环境。
路由 slug `lemon-squeezy` 显式映射到内部 `ProviderName = "lemonSqueezy"`；外部 slug 与内部
discriminant 分别只有这一份映射表，不能在各框架 wrapper 自行转换。

connection resolution 顺序：

1. 显式 `:connection`（推荐多账户部署）。
2. provider + webhook key ID / endpoint ID header 查找。
3. 仅有一个该 tenant/provider 的环境时使用显式 deployment binding。
4. 否则返回 400 `connection_ambiguous`，绝不试验多个 secret。

环境来自 connection 配置、provider header 或 endpoint binding，不能由 untrusted body 的
`mode` 字段覆盖。test/live 两条 endpoint 应分别配置，即使 provider 允许共用 URL。

## 2. Request processing pipeline

```text
Request
  -> route/connection allowlist
  -> content-type + max body (default 256 KiB)
  -> read raw Uint8Array once
  -> provider.verify(raw, headers, secret, clock)
  -> derive stable external delivery key
  -> inbox claim (tenant, connection, delivery key)
  -> persist raw evidence digest/reference
  -> enqueue canonicalization
  -> return 2xx
```

验签失败、过大、连接不明和重放拒绝返回 4xx；inbox/database 暂时失败返回 5xx 让 provider
重试。重复已成功事件返回 200/204；重复但 processing 中返回 202，不能再次产生 side effect。

不要在 HTTP request 中同步调用 provider API、发邮件、发 license 或更新宿主订单。业务 consumer
在 queue/outbox 中执行，并由事件 ID 幂等。

## 3. Provider signature table

| Provider | Header / scheme | Raw input | Replay/idempotency |
| --- | --- | --- | --- |
| Stripe | `Stripe-Signature`，官方 HMAC helper | raw body + timestamped signatures | event `id`；保留 tolerance，处理 secret rotation |
| Dodo | Standard Webhooks headers (`webhook-id`/timestamp/signature) | raw body | `webhook-id`；官方重试最多 8 次 |
| Polar | Standard Webhooks envelope | raw body；兼容旧 secret UTF-8 和 2026-09-08 起的新 `whsec_` base64 secret | event ID；最多 10 次，连续失败会 disable |
| Creem | `creem-signature` HMAC-SHA256 | raw body | event ID + 5 delivery attempts |
| Waffo | `X-Waffo-Signature: t=...,v1=...` RSA-SHA256 | `${t}.${rawBody}` | namespaced raw SHA-256；`id`/`eventId` 是业务实体引用 |
| Lemon Squeezy | `X-Signature` HMAC-SHA256 | raw body | 无独立 delivery ID 时用 namespaced raw SHA-256；最多四次重试 |
| Paddle Billing | `Paddle-Signature` HMAC-SHA256 | `${ts}:${rawBody}` | notification `event_id`；5 秒内 ack，按官方重试策略 |
| x402 | merchant notify envelope / signed receipt | raw envelope + receipt bytes | nonce/payment identifier/tx hash；链上 evidence 再核验 |

准确的 header parsing 和 timestamp tolerance 只在 provider adapter 中实现；统一 handler 不做
“猜算法”。所有 secret 支持 active + previous key overlap，rotation 完成后再删除旧 key。

Polar endpoint 的 `api_version` 独立于请求的 `Polar-Version`，需要在 Polar 中显式设置为
`2026-10`、`2027-01`。版本判断使用验签后的 raw JSON `api_version`，不信任未签名的
`webhook-api-version` header。兼容 `2026-04` 与无版本的历史 payload，因为已创建事件的重投
保留原版本；未知或格式错误的版本不解读 resource 字段、不查 mapping，只产生
`unmapped_provider_event.v1` 并保留 raw inbox evidence。未来适配后可从原始 evidence 重放。
验签和 inbox 持久化仍先于版本判断，不因未知版本拒绝接收。secret 的新旧签名算法按 secret
生成方式兼容，与 API 日期无关；升级 API 不能自动轮换已有 endpoint secret。

不能用 `event type + resource ID` 作为通用去重键；同一 subscription 会合法产生多次同类型更新。
如果 provider（例如 Lemon Squeezy 当前 webhook）不提供独立 delivery ID，adapter 使用
`<provider>:sha256(rawBody)`。相同 bytes 的合法重复投影为同一事实；不同 payload 生成不同 key，
aggregate version/reconciliation 继续负责顺序与最终状态。

## 4. Inbox schema and state

```text
received -> verified -> queued -> processing -> applied
                         |             |
                         +-> dead_letter +-> retry_wait
```

`polybill_inbox` 至少保存：tenant、connection、environment、external delivery key、可选 provider
event ID、event type、received/occurred time、payload digest、encrypted raw reference（可选）、
verification key ID、state、attempts、last error code、canonical event IDs。

唯一键是 `(connection_id, external_delivery_key)`；不能跨 connection 只用 provider event ID，
因为 test/live 和多个 account 可能重复。

raw payload retention 按 tenant policy 配置；删 raw 不删 digest、headers 摘要、canonical event
和 audit evidence。PCI/PII 合规要求更严格时只保存加密 R2 reference。

入站 claim 同时取得 60 秒 dispatch lease，队列发送成功后调用 `markQueued` 清除 lease。
发送失败记录 `queue_dispatch_failed`；后续 provider retry 原子重领失败记录，进程在发送前崩溃则
在 lease 过期后重领。发送成功但本地确认丢失可能导致重复 Queue delivery，canonical outbox
按 scope + delivery + event type + aggregate 幂等。`markFailed` 不得回退 applied 状态。
D1 的 `0011_inbox_dispatch.sql` 增加 nullable lease；旧记录保留原 state，并按已派发处理。
新增 `WebhookInboxStore.markQueued` 是宿主 store port 的必要升级。

## 5. Canonical event mapping

归一化 mapper 必须：

- 只在 provider schema decode 成功后读取字段。
- 使用 mapping lookup 找 canonical aggregate；找不到时生成 `unmapped_provider_event`，不
  伪造 Polybill customer/order。
- 保留 provider raw status、resource version、event type 和 external IDs。
- 对重复/乱序事件使用 aggregate version、provider updated time 或重新 GET。
- 未知事件类型写 inbox + warning + 2xx；升级 adapter 后可 replay。

最低 canonical events：

```text
catalog.product.changed
catalog.price.changed
customer.created / customer.updated
checkout.created / checkout.completed / checkout.expired
payment.created / payment.processing / payment.succeeded / payment.failed
refund.created / refund.succeeded / refund.failed
subscription.created / subscription.changed / subscription.past_due
subscription.canceled / subscription.paused / subscription.resumed
entitlement.granted / entitlement.revoked
license.issued / license.changed
dispute.created / dispute.changed
```

## 6. Ack and retry policy

- `2xx`：签名有效、inbox 已安全持久化，后续业务异步执行。
- `400`：签名/连接/body 永久无效；provider 通常不应继续重试。
- `401/403`：secret 无效或 replay；告警并人工处理，避免 provider 重试风暴。
- `413`：超过 body limit；保存最小 evidence（若安全）并拒绝。
- `429`：只用于本地 rate limit，不能让 provider 误判为暂时业务失败；优先 queue。
- `5xx`：inbox 未写成功、存储不可用或代码崩溃，允许 provider retry。

handler 不能为了“让 provider 停止重试”在验签失败时返回 2xx。对未知 event 选择 2xx 是有意
设计，因为原始事件已经安全持久化。

## 7. Reconciliation and replay

- 每个 connection 有周期性 cursor poller；poller 发现的资源进入同一 mapper，但 evidence
  `source = reconciliation`。
- `replayInbox(eventId)` 只重跑 canonicalization/outbox，不能重复原始外部副作用。
- `reconcileAggregate(id)` 可 GET provider authoritative object，再按 policy 修 projection。
- 如果 provider 允许 Dashboard redelivery，仍以本地 inbox 为真；两次 delivery 只产生一个
  canonical event。

## 8. Host integration

宿主只需把不同 provider 的 endpoint 都指向同一个 handler，并提供：

```text
POLYBILL_WEBHOOK_URL=https://app.example.com/webhooks/polybill/{provider}
POLYBILL_CONNECTION_ID=conn_live_stripe
```

宿主业务使用 canonical event consumer，不需要保留七套 provider handler。框架 middleware
必须关闭 JSON body parser 或提供 raw-body hook，否则签名验证会失败。

## 9. Operational controls

- connection 级 secret rotation、暂停接收、redelivery、dead-letter replay。
- 指标：received、verified、duplicate、invalid、queued、applied、latency、retry、unknown event。
- trace/log 只带 tenant hash、connection ID、event ID、aggregate ID、provider request ID；不带
  body、signature、secret、license 或完整 email。
- 所有 webhook event schema fixture 在升级前回放；provider API 变更触发 drift alert。
