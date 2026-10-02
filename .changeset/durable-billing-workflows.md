---
"@polybill/core": minor
"@polybill/adapter-kit": minor
"@polybill/application": minor
"@polybill/store-memory": minor
"@polybill/store-d1": minor
"polybill": minor
"@polybill/provider-stripe": minor
"@polybill/provider-polar": minor
"@polybill/provider-dodo": minor
"@polybill/provider-creem": minor
"@polybill/provider-paddle": minor
---

Add exact fractional billing rates, scoped durable billing state and credit ledger, and recoverable
subscription authorization and deferred-change workflows. Keep payment finality and native provider
schedule guarantees separate from local orchestration.

Add Stripe, Dodo and version-pinned Polar meter ingestion, with durable duplicate protection and
authoritative Dodo/Polar event recovery. Expose explicit Paddle resume billing-period policy.
Prevent read-back reconciliation from rearming schedules rejected for ownership conflicts or missed
windows.
