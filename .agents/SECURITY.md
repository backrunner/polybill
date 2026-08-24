# 安全设计

## 1. Trust boundaries

不可信输入包括：宿主 API input、provider HTTP response、webhook body/headers、migration export、
metadata、URL、customer PII、x402 notify/receipt 和 chain RPC。TypeScript 类型不构成信任；所有
边界都运行 runtime codec 和长度限制。

可信度也分层：验签 webhook 只证明“持有 provider secret 的发送方生成该消息”，不证明资源仍
处于相同状态；高风险动作需要 provider API/chain read-back。

## 2. Primary threats and controls

| Threat | Controls |
| --- | --- |
| Webhook spoof/tamper | raw bytes signature verification、constant-time compare、key ID、timestamp |
| Replay/duplicate | provider delivery ID/raw digest unique key、nonce store、idempotent consumer、tx hash uniqueness |
| Cross-tenant confused deputy | tenant + connection + environment on every key/query; no caller-supplied merchant override |
| Double charge after timeout | provider idempotency、query-before-retry、`outcome_unknown` recovery |
| Under/over charge | integer money、bound settlement quote、currency/asset match、order snapshot、refund invariant |
| License brute force | >=128-bit random code、HMAC lookup digest、rate limit、constant-time compare |
| Voucher double redemption | transactional CAS/DO serialization、immutable redemption ledger |
| Secret leakage | secret resolver、redacted errors/logs、no serialization、rotation key ring |
| SSRF/open redirect | URL parser、HTTPS、host allowlist/public DNS policy、same-origin path resolution |
| Malicious provider payload | bounded reader、runtime schema、unknown enum handling、no prototype merge |
| Supply-chain/runtime drift | lockfile、provenance、pack allowlist、dependency audit、workerd import scan |
| x402 forged/forked settlement | trusted receipt signer、expected tuple、chain confirmations、reconciliation |

## 3. Secret management

- credentials、webhook secrets、HMAC pepper、encryption KEK 和 x402 keys 使用独立 secret type。
- config dump/inspect 只显示 secret reference 与 key ID，不显示 value。
- Cloudflare 使用 secret bindings；Node 使用调用者提供的 secret manager resolver。
- secret 只在一次 operation context 存活，不缓存进全局 object 或 snapshot。
- webhook rotation 同时接受 active/previous key，记录 matched key ID；过渡结束后显式撤销。
- provider API key scope 采用最小权限；migration read-only 与 runtime write key 分离。

## 4. Web Crypto baseline

core 只依赖 `globalThis.crypto.subtle` 和 `crypto.getRandomValues`。需要：

- HMAC-SHA-256：webhook、license digest、opaque cursor。
- SHA-256：payload/evidence hash。
- AES-GCM：可恢复 license/raw evidence envelope encryption。
- RSA-PKCS1-v1_5 SHA-256：Waffo request/webhook signature（按官方协议）。

PEM/DER parser 必须有长度和算法检查，拒绝弱 key/未知 algorithm。禁止在 edge core fallback 到
非密码学随机数。若运行时缺少所需 algorithm，初始化失败，不降级验签。

## 5. License and voucher secrets

生成格式可读但 entropy 独立，例如 prefix + 128-bit random payload + checksum。checksum 仅检测
输入错误，不是认证。

存储：

```text
lookup_digest = HMAC-SHA-256(tenant_pepper, normalized_code)
ciphertext     = AES-GCM(data_key, plaintext, aad=tenant|license_id|version)
```

默认不保存 ciphertext，只在业务要求再次显示/下载时保存。key normalization 规则版本化，避免
升级后无法查找。API/log/analytics 只显示 prefix + last4。validate/redeem endpoint 按 tenant、IP、
code prefix 限流，但错误不区分“不存在”和“已被猜中”。

## 6. PII and payment data

- Polybill 不接收或保存 PAN/CVC；hosted/embedded provider UI 负责 card capture。
- payment method 只保存 opaque provider ID、brand/last4/expiry 摘要（按合规需求最小化）。
- email/address/tax ID 加密或由宿主持有；projection 可只保存 customer external ID。
- raw webhook/provider response 设置 retention 和字段级 redaction；证据 hash/audit 可长期保留。
- “删除 customer”先 tombstone Polybill PII，再调用 provider；MoR 法定留存导致未删除时返回
  partial result，不伪造成功。
- 使用本库不自动使系统 PCI/GDPR/税务合规；部署者仍需法律与合规评审。

## 7. URL and network safety

- success/cancel URL 默认要求 HTTPS，localhost test 例外；可配置 exact origin allowlist。
- provider API base URL 使用 adapter 常量；自定义 URL 仅 test 或明确 allowlist。
- webhook callback/notify URL 拒绝 credentials、fragment、IP literal、localhost、私网和保留域。
- 若服务端主动发 callback，解析 DNS 后仍需防 rebinding，并限制 redirect 为 0 或同 origin。
- provider fetch response 有 connect/total deadline、body byte cap、JSON depth/field bounds。

## 8. Tenant and environment isolation

所有 command 由 server-side authenticated tenant context 注入 tenant ID，不能从 body 直接信任。
Store repository method 必须要求 `StoreScope { tenantId, connectionId, environment }`，没有无 scope
的 `getByExternalId()`。

test/live credential 类型可以在 compile/runtime 同时区分。遇到 key prefix、base URL、payload mode
不一致时 fail closed 并产生 security alert。

## 9. Audit and observability

不可变 audit 记录 actor、operation、canonical ID、connection、result、idempotency key digest、
evidence ref 和时间。不得记录 raw secret/PII/body。

安全指标：invalid signature、replay、connection ambiguity、mapping collision、outcome unknown、
refund invariant violation、license brute-force、voucher CAS conflict、provider schema invalid。

## 10. Release security gates

- threat model 随新 capability 更新。
- signature/money/idempotency/redemption critical path branch coverage 100%。
- dependency license/security audit 和 npm provenance。
- secret scanner、fixture PII scanner、bundle Node built-in scanner。
- fuzz/property tests 覆盖 raw webhook parser、money codec、cursor、PEM/header parser。
- adapter stable 前进行 SSRF、replay、cross-tenant 和 outcome-unknown 专项 review。
