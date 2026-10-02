---
"@polybill/application": minor
"@polybill/store-memory": minor
"@polybill/store-d1": minor
---

Require atomic version-checked resource replacement for subscription updates, cycle reconciliation
scans with isolated bounded child keys, and confirm subscription lifecycle command postconditions.
Custom ApplicationStore implementations must implement replaceResource; no database migration is
required for bundled stores.

Persist an unknown-outcome marker before resource mutation transport and reject stale resurrection
of canceled subscriptions or malformed snapshot fields.
