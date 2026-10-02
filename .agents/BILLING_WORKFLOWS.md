# Durable billing workflows

This additive contract extends the subscription review. It does not promote an adapter beyond
experimental or treat checkout completion, an accepted usage event, or a webhook as payment finality.

## State and storage

The optional billing control store is scoped by tenant, connection and environment. Records use
compare-and-swap versions (create expects zero); due work is enumerable without depending on a
webhook. An executor persists an attempt before a remote mutation. An ambiguous attempt is recovered
by authoritative read-back, never by replaying an unconfirmed billing mutation with another key.
The D1 implementation adds only `polybill_*` tables. BillingStore is optional; custom application
stores must additionally implement the insert-only `insertResource` port before upgrading.
That port may complete a missing mapping/snapshot after a crash but must never replace an existing
snapshot or silently rebind either side of an external identity mapping.

Credit entries are immutable, integer unit strings, independent of fiat money. Each account has a
monotonic revision and an exact balance. Appending an entry and advancing its balance is one atomic
operation, with unique scoped operation IDs. Concurrent debits cannot spend the same balance twice;
replaying a key with different intent conflicts. Credits never imply a provider wallet transfer.

## Fractional pricing and mixed intervals

Fractional minor-unit rates use decimal strings, a currency, and explicit rounding at the extended
amount boundary. They are not `Money`; no intermediate floating point or per-unit rounding is
allowed. Graduated and volume tiers have distinct algorithms. Integer catalog prices remain
backwards compatible. Subscription items may retain independent observed period boundaries; a
subscription-wide period must not be synthesized from mixed intervals.

## Checkout binding

A scoped canonical checkout can be polled for subscription authorization. Only an authoritative
checkout read may identify its resulting subscription; the subscription is then independently read
and projected through the existing customer/price mappings. No email-based identity inference or
caller-supplied provider subscription ID is accepted. Pending/failed/expired authorization remains
distinct from a bound subscription. Binding does not mark an order paid or grant entitlements.
Bindings reuse a deterministic scoped canonical ID and never overwrite a newer snapshot on replay.
Existing canonical customer mappings are required; checkout creation passes the mapped customer
to providers that support it. Missing mappings fail explicitly rather than creating a second identity.

## Deferred item changes

Polybill schedules are an opt-in emulated workflow, driven by the host scheduler. They carry explicit
proration and a latest execution time, and retain the expected current items. A late or conflicting
schedule requires review instead of silently changing a later billing period. A persisted attempt
can only be completed by read-back of the desired items; an unchanged remote result does not prove
that an earlier request cannot still arrive. Canceling local pending work never cancels a provider
subscription. Native provider schedules and their precise invoice-time guarantees remain separate.
Schedule creation first persists a recoverable preparing record, then claims the subscription owner,
then arms the due time. A crash between these steps is recoverable through create replay or runDue;
an owner conflict disarms the competing record for review. Preparing records never send mutations.
Read-back reconciliation can advance only an attempted mutation or its unconfirmed-attempt review
state. Late, changed, and ownership-conflict schedules cannot be rearmed by observing matching items;
they must be canceled and replaced with a new explicit intent.

## Usage

Usage event IDs and meter definitions are canonical, immutable and scoped. Quantities are nonnegative
integer strings. Each provider adapter declares its ingestion timestamp window and deduplication
behavior. Accepted ingestion is not invoice finality. Retry of an uncertain ingestion first reads
back the exact event where supported. Local credits and usage cannot masquerade as native provider
meters or wallets. Provider event-name/value-property configuration remains an explicit binding.
Native ingestion currently covers Stripe, Dodo, and both reviewed Polar dates. Meter creation and
ingestion do not attach a metered price to a subscription. Product/price bindings and provider invoices
remain separate setup and verification requirements. An event name may match multiple native meters;
callers must configure the intended provider filters and prices accordingly. Stripe unknown event
outcomes require external reconciliation; no automatic replay is performed. Dodo can recover by
matching the complete event retrieved by ID. Polar ingestion reserves `polybill_event_id` metadata
for a scoped event marker because its event read schema does not return the input `external_id`.
Recovery filters by this marker, customer and event name, then verifies a unique returned event's
customer, name, timestamp and quantity. Missing or not-yet-visible events remain unknown; duplicate
ingestion acknowledgments require the same read-back. Existing events without the marker are never
blindly resent. Neither recovery path establishes invoice finality.

## 中文

新增可选控制面存储，以租户、连接、环境隔离工作流，版本条件写入保证并发安全；额度流水只增
不改，余额与流水一次提交。小数费率和整数金额分开，按明确规则对总额取整。异步订阅只能通过
结账读回与订阅读回建立绑定，不通过邮箱猜测身份，不将结账完成当成收款最终性。延期变更必须
由宿主调度器执行，超时、冲突或未知结果进入核对流程，不盲重试扣费。
