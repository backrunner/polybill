---
"@polybill/store-drizzle": minor
---

Add a database-neutral Drizzle persistence anti-corruption layer. Store adapters can execute
replay-safe session steps inside a Drizzle transaction when available, or use an explicit sequential
fallback for databases without transactions while preserving operation and partial-failure context.
