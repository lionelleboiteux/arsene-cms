# arsene-cms — Instrumentation proof (verify gate)

> Run by hand by Bob, against a real Postgres 16 (Testcontainers) and a real
> running Edge Function server (`src/api/server.ts` / `serverMain.ts`), driven
> over real HTTP with `fetch`, exactly as `bob-instrumentation` requires:
> exercise the feature, read the events back out of the actual store, compute
> the metric by hand. Script used: a throwaway `scripts/tmp-verify-instrumentation.ts`,
> deleted after the run — not committed, per the same policy given to the
> perf-analyst subagent.

## Part A — the metric is computable

A draft was seeded with `created_at` = now − 47 minutes (standing in for when a
writer would have started it), a real ~1KB JPEG cover was uploaded over real
HTTP, and the article was published over real HTTP. Real rows retrieved
straight from `telemetry_events` with raw SQL, no test helper:

```json
{"event_type":"draft_started","writer_id":"c4ba71e2-fa53-4df8-b4de-dac7f7167a0d","article_id":"de0541d4-21d2-48ce-9d92-f8cd91279f6d","occurred_at":"2026-08-12T05:18:40.290Z","payload":{"started_at":"\"2026-08-12T05:18:40.29+00:00\""}}
{"event_type":"article_published","writer_id":"c4ba71e2-fa53-4df8-b4de-dac7f7167a0d","article_id":"de0541d4-21d2-48ce-9d92-f8cd91279f6d","occurred_at":"2026-08-12T06:05:40.381Z","payload":{"is_republish":false,"published_at":"2026-08-12T06:05:40.381Z","telemetry_event_id":"e1c0da0a-ee29-485f-bd2e-0cdbd94ab8ba"}}
```

**Hand computation:** `06:05:40.381 − 05:18:40.290 = 47.00 minutes` — matching
AC-18's own worked example (10:00 → 10:47 = 47 minutes) almost exactly, by
coincidence of the seed chosen, not by construction. The metric (draft-to-publish
time) is genuinely computable from what's actually stored, using nothing but
`telemetry_events` and a subtraction.

## Part B — the denominator stays honest

A second draft was published with no cover image over real HTTP:

```json
{"error":{"code":"COVER_IMAGE_REQUIRED","message":"This article has no cover image.", ...}}
```
Response: `400`. Querying `telemetry_events` for that article afterward:
`[]` — zero rows. **Confirmed for real:** a refused publish writes no
`article_published` row, so a completion-rate computed from this data would
not be inflated by counting refusals as if they never happened, nor deflated by
counting them as failed publishes that still "started" — they simply don't
enter the numerator or denominator of a rate computed from these two events
directly, which is the correct behavior per Pam's spec.

## Part C — a real, load-bearing gap: the designed `draft_started` seam is unreachable

`02-architecture.v1.md` §9 (added after red) requires draft creation to go
through "a thin server-side seam (`src/api/createDraft.ts` — an RPC or Edge
Function, not a raw insert) that emits `draft_started` itself, exactly once."
That module exists and is unit-tested (`tests/telemetry/emission.test.ts`) —
but checking whether it is actually wired into the running system:

```
$ grep -rn "createDraft\|handleCreateDraft\|handleOpenDraft\|insertDraft\|takeLock" src/ tests/support/
src/api/createDraft.ts:33:    insertDraft(input: ...): Promise<{ id: string }>;
src/api/createDraft.ts:35:    takeLock(input: ...): Promise<boolean>;
src/api/createDraft.ts:42:export async function handleCreateDraft(...
src/api/createDraft.ts:69:export async function handleOpenDraft(...
tests/support/fakes.ts:267:      insertDraft: async () => { ... },
tests/support/fakes.ts:273:      takeLock: async () => o.lockTaken ?? true,
```

Nothing in `router.ts`, `server.ts` or `serverMain.ts` imports `createDraft.ts`.
`ROUTE` in `router.ts` only matches `/publish` and `/images` — there is no HTTP
path that reaches `handleCreateDraft`/`handleOpenDraft` at all.

Proven definitively, not just by absence of a grep hit — a standalone
`tsc --noEmit` check assigning the real `createRepo(pool)` to
`CreateDraftDeps['repo']` **fails to compile**:

```
error TS2739: Type '{ getArticle(...): ...; getArticleImages(...): ...; getWriterDisplayName(...): ...;
markPublished(...): ...; demoteCurrentCover(...): ...; insertImage(...): ...; recordTelemetry(...): ...; }'
is missing the following properties from type '{ insertDraft(...): Promise<{ id: string }>;
getArticle(...): ...; takeLock(...): ...; }': insertDraft, takeLock
```

`src/api/repo.ts` never implements `insertDraft` or `takeLock`. So even setting
aside the missing HTTP route, `handleCreateDraft`/`handleOpenDraft` **cannot be
wired to the real repository as it exists today** — this is not a missing route
that could be added trivially, the dependency the handlers need doesn't exist
on the concrete implementation.

**Consequences, stated plainly:**

1. **AC-05 (draft locking — "writer B sees the draft is locked… and cannot
   edit until writer A closes it") has no reachable enforcement path in this
   build.** The domain logic (`src/domain/lock.ts`, staleness calculation) is
   correct and fully unit-tested; the DB schema has `locked_by`/`locked_at`
   columns; but the handler that would actually check and take a lock when a
   writer opens a draft is never invoked by anything reachable from outside
   the test suite.
2. **The metric proven computable in Part A works only because of the
   fallback**, not the designed primary path. `repo.ts`'s
   `ENSURE_DRAFT_STARTED_SQL` backfills `draft_started` from
   `articles.created_at` at publish time — which is exactly the "bare client
   insert" mechanism §9 said needed replacing, because a client bug could
   silently lose the metric's numerator. In practice, nothing has replaced it;
   the replacement was built but never connected.
3. This is real production code, correctly unit-tested in isolation
   (`tests/telemetry/emission.test.ts` passes because it calls
   `handleCreateDraft` directly against `tests/support/fakes.ts`'s fake repo,
   which does implement `insertDraft`/`takeLock`) — the gap is purely at the
   integration boundary, which is precisely what a unit-test-only green gate
   cannot catch and this verify gate exists to catch.

**This blocks the verify gate.** Not because the time-to-publish metric can't
be computed today (it can, via the fallback) — because a named acceptance
criterion (AC-05) has no working implementation reachable in the shipped
system, discovered only by trying to exercise it for real. Recommended fix,
small and scoped: (a) add `insertDraft`/`takeLock` to `createRepo` in
`src/api/repo.ts`, mirroring the SQL pattern already used for
`ENSURE_DRAFT_STARTED_SQL` and the `locked_by`/`locked_at` columns in the
migration; (b) add two routes to `router.ts`'s `ROUTE` pattern (or a
Postgres-RPC equivalent, if that's preferred to keep matching the "direct
PostgREST" framing for everything except telemetry-bearing operations) calling
`handleCreateDraft`/`handleOpenDraft`; (c) once wired, decide whether the
publish-time backfill in `ENSURE_DRAFT_STARTED_SQL` should be removed (now
redundant with a working primary path) or kept as a defensive fallback for
rows that predate the fix — the latter is safer and cheaper, and matches
`on conflict do nothing`'s existing role as a convergence guarantee rather than
the primary mechanism.
