---
"@polybill/adapter-kit": patch
"@polybill/application": patch
"@polybill/provider-stripe": patch
"@polybill/provider-polar": patch
"@polybill/provider-dodo": patch
"@polybill/provider-creem": patch
"@polybill/provider-lemonsqueezy": patch
"@polybill/provider-paddle": patch
---

Reconcile the complete subscription projection, validate preflight identities, read complete Stripe
item lists, preserve Creem product mappings and reject ambiguous multi-item upgrades, and retain
Paddle automatic resume dates. Preserve scheduled cancellation access cutoffs and reject period-end
item changes that applied immediately or retained a conflicting schedule.
