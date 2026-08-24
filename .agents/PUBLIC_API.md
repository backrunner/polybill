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
| `@polybill/provider-*` | provider-specific adapter translation | required per adapter |
| `polybill` | composition root and curated facade | yes |

## Compatibility rules

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
