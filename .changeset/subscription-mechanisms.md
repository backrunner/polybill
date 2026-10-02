---
"@polybill/core": minor
"@polybill/adapter-kit": minor
"@polybill/application": minor
"polybill": minor
"@polybill/testing": patch
"@polybill/provider-polar": minor
"@polybill/provider-stripe": patch
"@polybill/provider-dodo": minor
"@polybill/provider-creem": minor
"@polybill/provider-lemonsqueezy": minor
"@polybill/provider-paddle": patch
"@polybill/provider-waffo": patch
"@polybill/provider-x402": patch
---

Support explicit Polar 2027-01 selection and close subscription lifecycle and projection gaps across
providers. Preserve scheduled changes separately from current items and collection pauses separately
from billing status. Add explicit pending-change reversal and trial-end operations with provider
constraints, request validation, read-back, and deterministic contract coverage.
