---
"@polybill/provider-dodo": patch
"@polybill/provider-creem": patch
"@polybill/provider-lemonsqueezy": patch
"@polybill/provider-waffo": patch
"@polybill/provider-polar": patch
---

Align subscription status, expiration dates and webhook identities with official API and integration
contracts. Keep Creem expiry nonterminal, distinguish Dodo collection failure from incomplete setup,
preserve Lemon Squeezy's authoritative cancellation cutoff and correlate Waffo lifecycle events with
their subscription order. Cover missing Dodo and Waffo lifecycle synchronization events. Keep Polar
unpaid revocation distinct from terminal subscription cancellation.
