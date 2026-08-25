---
"@polybill/store-d1": patch
---

Add an injectable D1 write coordinator with sequential replay fallback for deployments without
transactional batches, and make multi-statement control-plane commits retry-idempotent.
