# 模块与工程结构

## 1. Workspace layout

采用 pnpm workspace，包按依赖方向而不是 provider 功能数量拆分：

```text
polybill/
|-- packages/
|   |-- polybill/                 Public facade and curated exports
|   |-- core/                     Pure domain, state machines, money, IDs
|   |-- application/              Commands, queries, orchestration, policies
|   |-- adapter-kit/              Provider SPI, HTTP, codecs, conformance kit
|   |-- webhooks/                 Web Request handler and event pipeline
|   |-- licensing/                License, entitlement, voucher domain
|   |-- migration/                Planner, importer, verifier, CLI library
|   |-- provider-stripe/
|   |-- provider-dodo/
|   |-- provider-polar/
|   |-- provider-creem/
|   |-- provider-waffo/
|   |-- provider-lemonsqueezy/
|   |-- provider-paddle/
|   |-- provider-x402/
|   |-- store-memory/
|   |-- store-d1/
|   |-- store-drizzle/            Database-neutral Drizzle persistence boundary
|   |-- store-postgres/           Optional after the D1 contract stabilizes
|   `-- testing/                  Fake provider, fixtures, contract runner
|-- apps/
|   |-- example-worker/
|   `-- example-node/
|-- fixtures/
|   `-- providers/                Sanitized, versioned webhook/API fixtures
|-- scripts/                       Release/schema/provider drift checks
|-- .agents/                       Design source of truth and project skill
|-- AGENTS.md
|-- pnpm-workspace.yaml
|-- tsconfig.base.json
`-- package.json
```

第一阶段不创建空包。按 [MILESTONES.md](./MILESTONES.md) 逐步引入，但最终依赖规则从第一天
生效。

## 2. Dependency direction

```text
core <- licensing
core <- adapter-kit
core <- application <- polybill
adapter-kit <- provider-*
application <- webhooks
webhooks <- polybill
application <- migration
application <- store-*
provider-x402 -> x402-paysdk (public package entry only)
```

- `core` 无 I/O、无 provider、无 store、无框架依赖。
- `application` 只依赖 port interface，不 import 具体 adapter。
- `provider-*` 不能互相依赖，也不能 import store implementation。
- provider migration scanner contract 位于 `adapter-kit`；`migration` 绑定 context 与 checkpoint，
  provider 包不得反向 import `migration`。
- `store-*` 不能 import provider adapter。
- `polybill` 是 composition root，不包含领域逻辑。
- framework helpers 只能包装 Web `Request`/`Response` handler。
- 循环依赖由 lint rule 和 dependency graph CI 阻断。

## 3. Package responsibilities

### `@polybill/core`

- branded ID、Money、AssetAmount、SettlementQuote、ISO datetime、pagination、metadata primitives。
- Product、SKU、Price、Customer、Order、Payment、Refund、Subscription DTO。
- 纯状态转移和不变量验证。
- canonical error codes 和 event envelope。
- 不导出 provider name 之外的 provider-specific 类型。

### `@polybill/application`

- command/query handlers、unit of work、idempotency coordinator。
- capability resolution、routing、retry/recovery decision。
- snapshot projection、outbox emission、reconciliation coordinator。
- `Clock`、`IdGenerator`、`Logger`、`Tracer`、`CryptoPort`、`SettlementQuoteResolver`、store ports。

### `@polybill/adapter-kit`

- provider SPI 和 capability schema。
- injected `HttpTransport`、timeout、bounded response reader、redaction。
- retry classification、rate-limit hints、request/response evidence。
- webhook verifier/decoder interface。
- adapter conformance suite；provider 包以它作为 dev test harness。
- runtime codec interface；初版可用 Valibot，但公共类型不暴露该依赖。

### `@polybill/webhooks`

- `/webhooks/polybill/:provider[/:connection]` Web handler。
- raw body 上限、connection resolution、signature verification、inbox claim。
- canonical event mapper 调度、dead-letter 和 replay API。
- Hono/Next/Node adapter 作为 subpath export，核心 handler 保持 Web API。

`polybill` facade 在显式注入 resolver、inbox 和 queue 后组合同一个 handler/consumer；存储和
Cloudflare Queue 仍由宿主提供，不在 facade 内创建全局连接。

### `@polybill/licensing`

- entitlement policy、grant/revoke/suspend。
- license batch、key digest、activation instance 和 offline token extension。
- voucher/card batch、redemption ledger、atomic consume。
- provider-native license mirror coordinator，不依赖具体 provider。

### `@polybill/migration`

- source scanner、capability diff、catalog/customer/subscription importer。
- plan schema、dry-run、checkpoint、resume、verify 和 cutback。
- host data bridge interface，不直接连接未知宿主表。
- CLI 只负责参数和输出；计划逻辑可作为 library 测试。

### `@polybill/provider-*`

每个 provider 包内部保持一致结构：

```text
src/
|-- index.ts              Public adapter factory and config
|-- capabilities.ts       Versioned capability declaration
|-- client/               Narrow HTTP endpoints and codecs
|-- catalog/              Request and response mappers
|-- customers/
|-- checkout/
|-- subscriptions/
|-- refunds/
|-- webhooks/             Verify, decode, canonical event map
|-- reconcile/            List/fetch cursors and evidence
|-- errors.ts             Provider error classifier
`-- internal/             No public exports
```

未支持的 resource folder 不创建空实现；capability 直接声明 `unsupported`。

### Store packages

- `store-memory`：确定性测试、单进程示例，不允许生产多实例使用。
- `store-drizzle`：数据库无关的 Drizzle session/transaction/sequential persistence boundary。
- `store-d1`：Cloudflare 默认，包含 migrations、D1 session/consistency 策略，并通过 statement
  adapter 使用 `store-drizzle` 的 batch/sequential backend；不再维护 D1 专用 coordinator。
- `store-postgres`：Node/Hyperdrive 部署；遵循相同原子 Store conformance tests。

### `@polybill/testing`

- `createFakeProvider()`：实现完整 canonical provider 行为，不模仿某一家。
- `createScriptedHttpProvider()`：按请求脚本返回 provider fixture。
- `signWebhookFixture()`：使用测试 secret 生成真实签名向量。
- virtual clock、deterministic ID、fault injection、event permutation。
- `runAdapterConformance(adapterFactory)` 和 `runStoreConformance(storeFactory)`。

## 4. Provider client policy

Cloudflare 基线使用窄范围 fetch client，并从官方 OpenAPI/文档固定 endpoint 和 schema。原因：

- Waffo Pancake SDK 当前使用 `node:crypto`。
- vendor SDK 的运行时支持与包体会独立变化。
- Polybill 只需要已承诺的 API 子集，不应把整家 SDK 暴露进公共 bundle。

允许复用经过 Workers 验证的官方 SDK，例如 Stripe/Paddle 的 worker export，但必须放在 provider
包内部并通过相同 conformance suite。任何 Node-only 优化放在显式 `/node` subpath，不得被
默认 export 静态引用。

请求编码使用结构化 API：JSON、`URLSearchParams` 或官方生成 serializer；禁止手拼 query、
form body 和签名 canonical string。Waffo/x402 等签名串使用独立 canonicalizer 和固定向量测试。

## 5. Build and exports

- TypeScript 5.9+，`moduleResolution: "Bundler"`，ESM-first。
- package export 至少提供 `types`、`worker`/`workerd` 和 `import` condition。
- source import 使用显式 `.js` 后缀，避免 Node/Worker 解析差异。
- `sideEffects: false`；只在经过验证时声明。
- public exports 只能来自 package `index.ts`；不允许 deep import internal module。
- source map 不包含 secret/fixture；发布包通过 `publint`、`attw` 和 pack allowlist。
- changesets 管理版本，core/adapter SPI 破坏性变更独立标记。

## 6. Code size and style

- 一个文件只承载一个主要概念；目标小于 400 行，硬性审查阈值 600 行。
- mapper、codec、HTTP endpoint 和 orchestration 分开，避免一个 provider 巨型 client。
- 优先 discriminated union、`satisfies`、exhaustive `never`；禁止 enum 的隐式数字值。
- `unknown` 进入系统边界，runtime decode 后才成为 domain type。
- 不使用 `as any`、非空断言或关闭 strict rule 来绕过 provider schema 差异。
- public comment 解释语义和不变量；不复述代码。
- 日志为结构化字段，禁止序列化完整 request/response/provider object。

## 7. Toolchain baseline

- pnpm、Changesets、TypeScript、ESLint flat config、Prettier。
- Vitest 运行 unit/contract tests。
- `@cloudflare/vitest-pool-workers` 或当前 Cloudflare 官方 workerd harness 运行 edge tests。
- Miniflare/Wrangler 执行 D1、Queue 和 Worker smoke test。
- API Extractor 或等价 public API report 防止意外导出变化。
- dependency-cruiser 或 madge 仅用于 CI 依赖方向检查，不进入 runtime。
