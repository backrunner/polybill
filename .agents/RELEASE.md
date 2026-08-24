# Release and Drift Process

## Required checks

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:workerd
pnpm test:migration
pnpm test:security
pnpm build
pnpm check:packages
pnpm check:worker-bundle
```

The default Worker import graph must contain no `node:*`, filesystem, socket or process-global runtime
dependency. Package tarballs are checked with `publint` before publication.

## Provider drift

For each provider, pin API/schema version and fixture provenance in `.agents/RESEARCH.md`. A drift job
must compare a new sanitized response/signature fixture with the current codec and capability manifest.
Unknown events are persisted and acknowledged; changed required fields fail reconciliation rather than
silently dropping data.

## Changesets and commits

Public canonical/API/SPI changes need a focused changeset. Commits use the repository identity
`BackRunner <dev@backrunner.top>` and subject format `xxx(comp): desc`.

## Stable promotion

No adapter is stable until every declared native mutation has offline proof, Workerd proof, a sandbox
read-back record, a rollback path and an owner for provider API drift. Missing credentials keep the
adapter experimental; they do not justify a skipped test or an implied production guarantee.
