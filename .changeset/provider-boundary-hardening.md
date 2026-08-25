---
"@polybill/application": patch
"@polybill/adapter-kit": patch
"@polybill/provider-stripe": patch
"@polybill/provider-paddle": patch
"@polybill/provider-waffo": patch
"@polybill/provider-dodo": patch
"@polybill/provider-polar": patch
"@polybill/provider-creem": patch
"@polybill/provider-lemonsqueezy": patch
"@polybill/store-memory": patch
"@polybill/store-d1": patch
---

Harden provider boundary behavior for response-loss recovery, environment-scoped credentials,
canonical payment mappings, refund ledger projections, and explicit unsupported capabilities. Stripe
payment lifecycle events now preserve processing/action-required/canceled states; dispute events
remain unmapped until a canonical dispute model exists. D1 commits use the write coordinator and
support replay-safe sequential execution.
