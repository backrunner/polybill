# Public API Report

状态：`0.1.x` experimental/preview baseline，2026-08-25。

这份报告以 package `index.ts` 和生成的 declaration 为准。Provider raw payload、provider
object ID 和法律责任不会成为 canonical public API。

## Facade

`polybill` 导出 `createPolybill`、canonical domain types、capability types、credential types 和
licensing types。`PolyBillOptions` 的连接必须包含 tenant、provider、environment、adapter、store
和延迟凭据 resolver。

资源客户端：

- `catalog` / `catalogSync`
- `customers`
- `checkouts`（含 ad hoc checkout）
- `orders.get` / `payments.get`
- `refunds` / `subscriptions`
- `discounts` / `discountSync`
- `entitlements` / `licenses` / `vouchers`（显式 licensing store 时启用）
- `migrations`（显式 migration target/store 时启用）
- `reconcile` / `getCapabilities`
- `webhooks.handler` / `webhooks.consume`（显式 resolver、inbox、queue 时启用）

`webhooks.handler` 只做 Web `Request -> Response` 的 method、route、body limit、raw signature
verify、inbox claim 和 queue send。业务映射由 `webhooks.consume` 异步完成。

## Package boundaries

| Package | Public responsibility | Node-free default |
| --- | --- | --- |
| `@polybill/core` | IDs、Money、catalog、commerce、subscription、errors | yes |
| `@polybill/adapter-kit` | provider SPI、capability、HTTP、codec | yes |
| `@polybill/application` | commands、idempotency、reconcile、ports | yes |
| `@polybill/webhooks` | unified handler、consumer、memory inbox | yes |
| `@polybill/store-memory` | deterministic test control plane | yes |
| `@polybill/store-d1` | D1 schema and control-plane implementation | yes |
| `@polybill/store-drizzle` | database-neutral Drizzle persistence coordinator | yes |
| `@polybill/provider-*` | provider-specific adapter translation | required per adapter |
| `polybill` | composition root and curated facade | yes |

## Compatibility rules

`billing?: { store: BillingStore }` enables `subscriptionSchedules`, `credits`, and `usage` services.
`subscriptionAuthorizations.refresh(checkoutId)` polls a scoped checkout and reads its subscriptions
through the configured adapter. A mapped canonical customer is currently required. Binding never
grants access or marks payment succeeded. `runDue` is called by the host scheduler and reports each
schedule/error separately. These optional workflows and their limitations are documented in
[BILLING_WORKFLOWS.md](./BILLING_WORKFLOWS.md).

Custom ApplicationStore implementations must add `insertResource`, an idempotent insert-only port
that rejects mapping conflicts and cannot overwrite an existing snapshot. Apply D1 migration 0012
when using D1BillingStore. Existing checkout/subscription snapshots need no destructive migration.

2026-10 store upgrade: custom `ApplicationStore` implementations must implement
`replaceResource(ResourceReplacement)`. Compare the current canonical `value.version` and scoped
external mapping atomically, require `value.version === expectedVersion + 1`, and throw `conflict`
without changing the snapshot when the comparison fails. Memory and D1 implement this port;
existing D1 tables require no migration. Reconciliation stream checkpoints now include mode and
restart after an empty terminal page; old checkpoints remain available for rollback.

自定义 store 需要实现上述原子版本替换接口，不能用“先读取、后无条件写入”模拟。订阅更新冲突
后重新对账，不盲重试远端写操作。内置 memory/D1 已适配，无需改宿主业务表。

- New fields are additive and optional only when they do not alter state semantics.
- Canonical status changes, SPI changes, store migration changes and provider capability changes need a
  changeset plus contract coverage.
- `native`, `emulated` and `unsupported` are part of the public capability contract.
- Provider-specific fields remain in evidence/snapshot payloads and must be redacted before logging.
- `test` and `live` are never inferred from credentials or webhook URL.

## Maturity

All first-party provider descriptors remain `experimental` until the external compatibility gates in
[COMPATIBILITY.md](./COMPATIBILITY.md) are completed. Passing offline tests does not upgrade an adapter
to stable or establish MoR, tax, invoice or dispute responsibility.
