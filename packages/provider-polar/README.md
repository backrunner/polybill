# Polar adapter

`createPolarAdapter()` defaults to `Polar-Version: 2026-10`. Opt into the reviewed Next version:

```ts
import { createPolarAdapter } from "@polybill/provider-polar";

const polar = createPolarAdapter({ apiVersion: "2027-01" });
```

Both versions have independent schema baselines. The selected version applies to every HTTP port,
read-back and reconciliation, and is reported in capabilities. Instances do not share mutable
version state. Successful responses must echo the selected version; mismatches fail reads and
preserve `outcome_unknown` for writes. There is no unpinned retry or version fallback. Paths remain
`/v1`.

2027-01 seat prices replace `seat_tiers` with `tiers` and add `minimum_units` / `maximum_units`.
Tier `unit_amount` values are decimal strings in minor units and may be fractional. Migration
evidence retains them exactly; it does not coerce them into integer Money or claim canonical
tiered-price import. Subscription reads and seat changes support the new nested price
representation.

Configure each Polar webhook endpoint independently with the selected `api_version` and
`format: raw`. The decoder accepts signed `2026-04`, `2026-10`, `2027-01`, and unversioned
historical payloads. Unknown versions remain unmapped inbox evidence. Versions are read from the
signed body, never the unsigned `webhook-api-version` header. Historical redeliveries retain their
original version.

Run `pnpm check:polar-api` and `pnpm check:polar-api -- 2027-01` from the repository root to compare
both reviewed surfaces with official schemas. These read-only checks need network access, not
credentials. Next remains mutable: a drift failure requires review before updating its baseline. See
the [official versioning policy](https://polar.sh/docs/api-reference/2026-10/versioning) and
[API changelog](https://polar.sh/docs/changelog/api). The adapter remains experimental; offline
fixtures and schema checks are not authenticated sandbox or hosted endpoint verification.

Subscription policies and cross-provider gaps are documented in
[the subscription coverage matrix](../../../.agents/SUBSCRIPTIONS_2026-10.md).

## 中文

默认固定 `2026-10`；通过 `createPolarAdapter({ apiVersion: "2027-01" })`
显式启用已审查的 Next 版本。两个版本分别维护契约基线，每个实例独立选择，所有请求、读回、对账和能力声明保持一致。成功响应必须回显相同版本；写入遇到版本缺失或不匹配时保持结果未知，不自动重发或回退。

2027-01 已兼容座位价格的新 `tiers` 结构及 `minimum_units` / `maximum_units` 边界。 `unit_amount`
可能是小数最小货币单位，迁移原始证据保留完整字符串精度；不将它强转为整数金额，也不宣称已完成 canonical 阶梯价格导入。订阅读取、座位变更及嵌套新价格响应有离线契约测试。

Webhook endpoint 的版本需要独立配置，升级客户端不会修改远端 endpoint。已验签的 `2026-04`、
`2026-10`、`2027-01` 和无版本历史事件均可处理，未知版本只保存为未映射证据。

运行 `pnpm check:polar-api` 和 `pnpm check:polar-api -- 2027-01`
检查两个版本的官方 schema。Next 发生漂移后需要重新审查，不自动更新基线。检查不需要凭据，也不能替代 sandbox 验证。完整订阅覆盖情况及尚未接入的机制见上面的覆盖矩阵。
