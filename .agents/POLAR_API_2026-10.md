# Polar API compatibility review

Reviewed: 2026-11-21. Adapter maturity remains experimental; no authenticated sandbox request or
hosted webhook endpoint change is part of this review.

## Official contract

- [Versioning](https://polar.sh/docs/api-reference/2026-10/versioning.md): versions are `YYYY-MM`,
  selected by `Polar-Version`. Paths stay under `/v1`. Without a pin the API uses Current.
  Successful responses report `Polar-Version`; malformed, unknown or removed versions return 404.
- [Changelog](https://polar.sh/docs/changelog/api.md): `2026-10` is scheduled as Current on October 1.
  Version releases occur in the first week of January, April, July and October. Deprecated is removed
  at the next release. Next is mutable and must not be adopted automatically.
- Raw webhook payloads include `api_version`; endpoint configuration is independent of API requests.
  Updating the endpoint affects newly created events only; redeliveries keep their original contract.

The adapter defaults to `2026-10` and accepts explicit `2027-01` selection, rather than merely reporting a version in capabilities. It requires
the matching response header before decoding a successful response. A mismatch or missing header
fails reads and preserves unknown mutation outcomes without retrying or switching versions.

## Schema comparison

Official source: `polarsource/polar` commit `95a6a235afda4d2dcc2888186e882e78950ed365`,
`docs/openapi/{version}.openapi.json`.

| Version | Full source SHA-256 |
| --- | --- |
| 2026-04 | `2dbb46c78f2a2956d2c6c7e170e4a8671f3d047ad784bff1acec1b20f69d1060` |
| 2026-10 | `344ab3770d538d8753533ba5c45c442b21ed9f18f37fafc892dc8d143bef853a` |

The original 2026-04 to 2026-10 review found equivalent shapes for the used checkout, customer,
subscription, product and order fields. The November refresh includes additional authorization
subjects, tighter optional field limits, and `trial_ended` on both API dates. Map `trial_ended` to
canonical `incomplete` and preserve the raw status. Polar uses it while awaiting payment setup
after a trial, before any later cancellation.

The changed contracts are webhook endpoint create/update (custom `secret` removed; Polar generates
new secrets, and the allowed endpoint `api_version` values expand) and license key responses
(`member_id`/`member` added). Polybill does not manage Polar endpoint creation or native license key
responses, so these do not change the canonical domain or grant ownership. Existing support for
legacy UTF-8 secrets and new Standard Webhooks secrets is preserved; do not infer signing mode from
the payload version or rotate secrets just to upgrade the API.

`packages/provider-polar/fixtures/api-contract.json` records hashes of the used operations and their
transitive schemas, plus the mapped webhook envelopes. It contains no credentials or customer data.
`pnpm check:polar-api` checks this reviewed surface against the official pinned schema. To check the reviewed Next baseline explicitly, run `pnpm check:polar-api -- 2027-01`. This online, read-only check is optional,
not part of required offline tests; differences fail and need review, never update the baseline.

## Reviewed Next version: 2027-01

Explicit selection is supported with `createPolarAdapter({ apiVersion: "2027-01" })`. Default remains
2026-10. Next is mutable, so each version has a separate reviewed baseline; both must be checked before
release. Webhooks accept the Next body version even when HTTP remains on 2026-10.

The candidate source SHA-256 is
`6def50a8f0228c017a7c3430c8b386d864d43b7b532c37552a91255f97a518e3` at the source commit above.
Seat prices replace `seat_tiers` with general `tiers` and add `minimum_units` / `maximum_units`.
`Tier.unit_amount` is an arbitrary-precision decimal string in minor currency units, not integer Money.
The migration scanner preserves that evidence unchanged; canonical tiered-price conversion remains a
separate unimplemented feature. Subscription decoders derive quantity from `seats` / `units`, not the
nested price format. Fixtures cover fractional rates and unlimited bounds without numeric coercion.
Provider-managed pending discounts in 2027-01 may exist alongside product or quantity changes.
Discount-only updates do not create canonical item schedules. Item edits and clearing pending
items check for a provider-managed pending discount before sending a mutation. New catalog
metadata, optional list filters, and webhook body event IDs are additive to fields used by Polybill.
The signed webhook ID remains the delivery key.

The expanded lifecycle and usage baseline covers 294 entries for 2026-10 and 293 for 2027-01, including
meter creation, event ingestion/list recovery, and active, cycled, migrated, past-due, paused, resumed
and uncanceled webhook envelopes. Unsupported API dates
fail before transport; only unknown webhook dates remain unmapped. No automatic version upgrade occurs.

The versioned `UserEvent` read schema does not expose ingestion's `external_id`. The adapter reserves
`polybill_event_id` metadata and queries `/v1/events/` with that marker, customer and name before
matching the complete event. Zero matches remain unknown; duplicate or mismatched results fail
closed. Existing events without this marker require external reconciliation, never blind replay.

## Upgrade and rollback

1. Compare the versioned API reference, changelog, schema and old/new HTTP and signed webhook fixtures.
   Keep the previous webhook codec while retained events may be redelivered.
2. Update the adapter pin and reviewed schema baseline together; run offline contracts, security,
   migration and Worker checks. Do not expose arbitrary date overrides without reviewed codecs.
3. In sandbox, verify the response `Polar-Version` on used operations and confirm read-back. Missing
   credentials mean this step remains unverified.
4. Separately set each Polar webhook endpoint's `api_version` to the selected reviewed version, with `format: raw`, keeping
   test/live endpoints and secrets isolated. Read back the setting and test new and old deliveries.
   The adapter cannot configure the remote endpoint automatically.
5. Deploy the client with its explicit pin. Investigate 404/version mismatches; never retry a mutation
   without the pin. Unknown webhook versions are acknowledged into the inbox but remain unmapped.
6. For rollback, deploy a reviewed prior adapter and explicitly restore endpoint configuration while
   that version is still supported. Retain new-version decoding for events already created. Removed
   versions cannot be restored; update the adapter and reconcile instead.
