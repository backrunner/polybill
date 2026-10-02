---
"@polybill/provider-polar": patch
---

Default Polar API calls to 2026-10 and validate the selected response version before decoding.
Preserve unknown mutation outcomes on version mismatch without retry or version fallback. Decode
reviewed 2026-04/2026-10/2027-01 and historical webhook payloads while retaining unreviewed versions
as unmapped evidence. Document independent webhook endpoint upgrades and add an opt-in upstream
schema check.
