---
"@polybill/store-drizzle": patch
---

Add a generic statement backend coordinator so database adapters can reuse the same batch/sequential
failure and replay semantics without depending on D1-specific types.
