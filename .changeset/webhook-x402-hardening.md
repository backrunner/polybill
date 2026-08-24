---
"polybill": minor
"@polybill/webhooks": patch
"@polybill/store-d1": patch
"@polybill/provider-x402": patch
---

Compose the unified webhook handler and consumer from the public facade, scope D1 and memory inbox
deduplication by tenant/connection/environment, validate x402 merchant reference responses before
projecting them into canonical checkout state, and report x402 subscription creation as unsupported
until a scheduled reauthorization workflow exists.
