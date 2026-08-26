---
"@polybill/store-d1": minor
---

Replace the D1-specific write coordinator with the database-neutral persistence boundary from
`@polybill/store-drizzle`. D1 stores now inject a shared statement adapter, while batch and
sequential failure semantics are defined by the Drizzle persistence package.
