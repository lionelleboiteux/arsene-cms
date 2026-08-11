# Consumer contract: Arsène → `pronos`'s `GET /v1/leagues/{leagueId}/current`

Status: architecture-gate design doc. No test code exists yet — this describes
what Arsène's own red gate will build, the same way `pronos`'s
`tests/contract/consumer.prism.test.ts` already does for its own consumers.
Not to be confused with `pdlc/arsene-cms/contracts/openapi.yaml`, which is
Arsène's own *provided* contract; this document is about Arsène as a
*consumer* of someone else's contract.

## 1. What this is for

AC-04 ("Structured pronos entry") lets a writer creating a "Pronos" article
fill in structured match fields — teams, score, confidence tier — instead of
free text. When the match being predicted is a real, currently-scheduled
fixture, the nicest version of that flow lets the writer *pick* the fixture
from a list instead of typing team names by hand: a "fixture picker" in the
editor SPA that calls the sibling `pronos` ("Jeu des Pronos") project's own
API to list a league's current gameweek and matches.

That endpoint is:

```
GET /v1/leagues/{leagueId}/current
```

defined at
`/Users/lionelleboiteux/work/pronos/pdlc/jeu-des-pronos/contracts/openapi.yaml:142-267`,
operation id `getCurrentGameweek`, response schema `CurrentGameweekResponse`
(same file, `:1184-1207`), built from `League` (`:1022-1046`), `Gameweek`
(`:1115-1139`), `Game` (`:1067-1113`), `Team` (`:1048-1065`), and
`GameWithPrediction` (`:1162-1182`).

## 2. This dependency is not live, and must never be assumed to be

Per the task brief: fixture ingestion has not shipped in `pronos` yet. Two
consequences follow directly, and both are binding on Arsène's design, not
just its tests:

1. **Arsène's own data shape for a Pronos entry's match reference is
   optional and nullable**, never a required foreign key. A writer can
   always fall back to typing team names by hand, exactly as they do today,
   whether or not `pronos` is reachable or has any data for the relevant
   league/gameweek. See §5.
2. **Arsène's CI never points this test at a real, deployed `pronos`
   instance.** The consumer test below runs against a Prism mock generated
   from `pronos`'s own contract, not against `pronos` itself — for the usual
   contract-testing reason (no live dependency, no flaky network call in
   CI), and *additionally* here because there may be no real `pronos`
   deployment serving real data at all yet.

## 3. What Arsène's fixture-picker actually needs from the response

Only a subset of `CurrentGameweekResponse` is relevant to a CMS editor
picking a fixture to reference (as opposed to `pronos`'s own player form,
which is what the full schema is designed for):

| Field used | From | Ignored |
|---|---|---|
| `league.id`, `league.code`, `league.name` | `League` | `league.logo_url` |
| `gameweek.id`, `gameweek.number`, `gameweek.stage_name` | `Gameweek` | — |
| `games[].game.id`, `.home_team`, `.away_team`, `.starts_at`, `.status` | `Game` | `games[].game.home_team_score`, `.away_team_score` (irrelevant before kickoff, which is when a writer is drafting a preview) |
| — | — | `games[].is_locked`, `games[].my_prediction` — both are `pronos` player-form concepts (submission lock, "your own pick"); Arsène never submits a prediction through this endpoint, so it never sends `?pseudo=` and always ignores these two fields |

The picker calls `GET /v1/leagues/{leagueId}/current` **without** the
optional `pseudo` query parameter (`:837-850` in the pronos contract) — that
parameter and everything it personalises exist for `pronos`'s player-facing
form, not for Arsène.

Two response shapes both count as success, and the picker must render both
without erroring:

- Populated: `gameweek` and `games` are non-empty — writer sees a list of
  fixtures to pick from.
- Empty, per the pronos contract's own documented normal case (`:178-182`,
  `:253-263`): `season_id: null, gameweek: null, games: []` — "no open
  gameweek right now (between seasons, or not yet configured)". The picker
  shows "no fixtures currently available for this league — enter details
  manually" and falls through to manual entry. This is **not** treated as an
  error by the picker, exactly as `pronos`'s own contract insists it is not
  an error (`200`, not `404`).

`404` (`leagueId` itself unrecognised — `:264-265`) and any `default`
(`UnexpectedError`, `:266-267`) response, plus any network failure or
non-2xx status not modelled by the contract at all (DNS failure, timeout,
CORS rejection — see §4), are all treated identically by the picker: log it,
show "fixtures unavailable — enter details manually", fall through to manual
entry. The writer is never blocked from finishing their article by this
dependency being unreachable.

## 4. Transport note: this is a real cross-project HTTP call, not PostgREST

Every other read in the Arsène editor is a direct PostgREST call against
Arsène's own Postgres. This one is the single exception: it is a browser-to-
browser HTTP call from the Arsène editor SPA to a *different* Supabase
project's Edge Function (`pronos`'s `/functions/v1/pronos-api/v1/leagues/...`
per its own `servers` block, `:73-84`). It requires `pronos` to serve
permissive CORS on this specific public, unauthenticated
(`security: []`, `:183`) operation. If `pronos` has not configured CORS (or
is down, or doesn't exist yet in a given environment), the fetch fails
client-side and hits the same "enter details manually" fallback as any other
failure in §3 — CORS/availability is explicitly not something Arsène's own
contract or tests assume is solved by the time Arsène ships.

## 5. Arsène's own data shape (informative — not a custom endpoint)

The match-reference fields on an Arsène "Pronos" structured entry (the
`pronos_entries` Postgres table backing AC-04, written directly by the
editor via PostgREST — out of scope of `contracts/openapi.yaml`, see that
file's "What is out of scope") are:

```jsonc
{
  "id": "uuid",
  "article_id": "uuid",
  "home_team": "PSG",            // required, free text — always writer-editable,
  "away_team": "Marseille",      // whether or not it was populated from a pronos fixture pick
  "predicted_home_score": 2,     // required, Arsène-only field — pronos has no concept of "predicted by the writer"
  "predicted_away_score": 1,     // required, Arsène-only field
  "confidence_tier": "Indispensable", // required, Arsène-only enum

  // --- optional/nullable match reference, never a required foreign key ---
  "pronos_league_id": "3f29b6d2-8b1a-4e2b-9c3a-111111111111", // nullable uuid; = pronos's League.id
  "pronos_game_id": "3c3c3c3c-0000-4a2b-9c3d-999999999999",   // nullable uuid; = pronos's Game.id
  "match_kickoff_at": "2026-08-10T19:00:00Z"                   // nullable date-time; copied from Game.starts_at at pick time, never re-synced afterward
}
```

`pronos_league_id`/`pronos_game_id`/`match_kickoff_at` are all `null` when
the writer typed `home_team`/`away_team` by hand (manual entry, whether by
choice or because the picker fell back per §3). When a fixture *was* picked,
these three are populated once, at pick time, as a **denormalised snapshot**
— Arsène does not re-fetch or reconcile against `pronos` later (e.g. if a
fixture is postponed after the writer already published). This mirrors why
`match_kickoff_at` exists as its own Arsène-owned column rather than a live
join: the two Postgres databases belong to two different projects and there
is no cross-database foreign key to hold this consistent, and no requirement
in the product spec that it be kept live-consistent after the writer picks
it.

## 6. Consumer test setup

Mirrors `pronos`'s own pattern (`tests/contract/consumer.prism.test.ts` +
`tests/support/prism.ts` in `/Users/lionelleboiteux/work/pronos`) exactly,
with the mock generated from `pronos`'s contract instead of Arsène's own.

**Vendoring.** Arsène's repo vendors a copy of `pronos`'s
`pdlc/jeu-des-pronos/contracts/openapi.yaml`, pinned to a specific git commit
of the `pronos` repo, at:

```
pdlc/arsene-cms/contracts/vendor/pronos-openapi.yaml
pdlc/arsene-cms/contracts/vendor/PRONOS_SOURCE.md   # records the pinned commit SHA + date vendored
```

Vendoring the *whole* file (not a hand-trimmed extract of just
`getCurrentGameweek`) is deliberate: Prism needs the full document to resolve
`$ref`s (`CurrentGameweekResponse` → `League`/`Gameweek`/`Game`/`Team` →
`Error`, etc.), and a hand-trimmed copy would silently drift from what
`pronos` actually ships the moment either project's schema changes. A small
script (`scripts/update-pronos-vendor.sh`, run manually, not on every CI
build) re-copies the file from a local checkout of `pronos` and updates the
pinned SHA; nothing in Arsène's CI fetches it over the network or from a live
`pronos` deployment.

**Mock.** At Arsène's own red gate, `tests/contract/pronos-fixtures.prism.test.ts`
starts `@stoplight/prism-cli mock` against the vendored file (same
`startPrismMock`-style helper as `pronos`'s `tests/support/prism.ts`, ported
into Arsène's own `tests/support/prism.ts`), scoped to
`GET /v1/leagues/{leagueId}/current` for the test's purposes even though the
whole vendored document is loaded.

**What the consumer test asserts** (per operation, mirroring
`CONTRACT-CONSUMER-*` naming in `pronos`'s own suite):

- `CONTRACT-CONSUMER-fixturePicker-populated`: Arsène's fixture-picker
  client function, pointed at the Prism mock's base URL, calls
  `getCurrentGameweek({ leagueId: LIGUE_1_ID })`, and the *rows it renders*
  (`{ gameId, homeTeamName, awayTeamName, kickoffAt }[]`) are asserted to
  come from `games[].game.{id,home_team.name,away_team.name,starts_at}` in
  whatever example Prism serves for the `200` response — proving the client
  parses the real contract shape, not a hand-written fixture the client
  author guessed at.
- `CONTRACT-CONSUMER-fixturePicker-emptyGameweek`: same call, but against
  Prism's `Prefer: example=noOpenGameweek` (selecting pronos's own
  `noOpenGameweek` named example, `:253-263` in its contract) — asserts the
  picker renders its "enter details manually" fallback state, not an error.
- `CONTRACT-CONSUMER-fixturePicker-notFound`: `Prefer: code=404` — asserts
  the picker falls back to manual entry (§3), the same as any other failure.
- `CONTRACT-CONSUMER-fixturePicker-unreachable`: Prism stopped / wrong port
  — asserts the picker's network-failure branch also falls back to manual
  entry (this is the case that stands in for "pronos isn't deployed yet" or
  "CORS not configured", §4, since Prism-down is the closest thing a mock
  can offer to "the dependency doesn't exist").
- Every asserted response is additionally schema-validated against
  `CurrentGameweekResponse` from the vendored file (same
  `validateAgainstSchema` helper `pronos` already has in
  `tests/support/openapi.ts`), so a client that happens to work against a
  malformed fixture still fails the test.

**No provider test on Arsène's side.** Arsène is purely a consumer of this
one operation; there is no reverse direction ("`pronos` consumes Arsène's
contract") for this interface, so nothing here runs Schemathesis against
anything Arsène owns. Verifying that the *real* `pronos` deployment actually
satisfies `getCurrentGameweek`'s contract is entirely `pronos`'s own
provider-side responsibility (`tests/contract/provider.schemathesis.test.ts`
in that repo) — out of scope of Arsène's test suite by construction. The
moment `pronos` ships fixture ingestion for real, re-running Arsène's
consumer suite against a freshly re-vendored copy of its contract (§ above)
is what would catch a breaking change on `pronos`'s side before it reaches
production; nothing currently automates "re-vendor and re-run" on a
schedule, since there is no live dependency yet to drift against.

## 7. Exit criterion for treating this as a live dependency

This stays mock-only until `pronos` has (a) actually shipped fixture
ingestion (so `GET /v1/leagues/{leagueId}/current` returns real data, not
just a contract-conformant empty state) and (b) a real deployed URL Arsène
can point a *staging* (never CI) environment at. Neither has happened as of
this writing (2026-08-11); until then, `pronos_league_id`/`pronos_game_id`
being populated in Arsène's own data (§5) can only happen once someone
manually wires that staging URL in, which is out of scope of this
architecture gate.
