---
"@polybill/adapter-kit": patch
"@polybill/application": minor
"@polybill/provider-stripe": patch
"@polybill/provider-dodo": patch
"@polybill/provider-polar": patch
"@polybill/provider-creem": patch
"@polybill/provider-waffo": patch
"@polybill/provider-lemonsqueezy": patch
"@polybill/provider-paddle": patch
"@polybill/provider-x402": patch
"@polybill/webhooks": minor
"@polybill/store-d1": patch
"@polybill/store-memory": patch
---

Harden payment transport, mutation outcome handling, checkout semantics and webhook identities
against the current provider documentation. Disable undocumented checkout POST recovery and Polar
multi-item carts. Keep checkout completion separate from payment success, enforce environment and
refund identity checks, and recover failed webhook dispatch without losing verified evidence.

See `.agents/PAYMENT_REVIEW_2026-09-06.md` for sources, compatibility limits and historical replay
notes.
