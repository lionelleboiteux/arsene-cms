# ADR-0002: Pronos owns fixture/match data; Arsène consumes it as optional, with manual entry as the v1 fallback

- **Status:** proposed
- **Date:** 2026-08-11
- **Unit:** arsene-cms
- **Deciders:** Lionel Le Boiteux, Bob

## Context

Writers creating a "Pronos" or "Player Picks" article (AC-04) need to reference a real
football match (teams, and eventually a score once known). The sibling `pronos`
project ("Jeu des Pronos") independently needs the exact same match data to lock player
predictions at kickoff. Neither system has actually built fixture ingestion yet —
pronos has a `games` table and an API shape for it
(`GET /v1/leagues/{leagueId}/current`), but the scraper/ingestion slice that populates
real match data was never started. The product owner explicitly wants a strong link
between the two (writers write about the same games players are predicting) but not a
shared database schema, since they may rehost the pronos game independently later and
may swap Arsène's CMS for an off-the-shelf product.

## Decision

Pronos remains the owner of fixture/match data. Arsène's structured Pronos-article
fields store team names, score, and confidence tier as plain values with an optional,
nullable reference to a pronos match/game id — never a required foreign key. Arsène's
editor calls pronos' `GET /v1/leagues/{leagueId}/current` to offer a match picker when
that data is available, and falls back to manual free-text entry when it isn't (which,
at launch, is the common case, since pronos hasn't shipped fixture ingestion).

## Consequences

**Positive**
- No shared schema — each system stays independently deployable, testable, and
  rehostable, matching the product owner's stated constraint.
- Arsène's Pronos-article feature is not blocked on pronos shipping a slice that was
  never started; manual entry is a real, always-available path, not a degraded one.
- When pronos does ship fixture ingestion, the integration upgrades from manual entry
  to picker-assisted entry without a migration — the nullable reference was always
  there.

**Negative**
- Duplicate data entry risk in the interim: a writer manually typing "PSG vs Marseille,
  2-1" and a player predicting against pronos' eventual real fixture for the same match
  are not the same row anywhere, so there's no automatic cross-reference or reconciled
  reporting between "what we wrote about" and "what players predicted" until pronos'
  ingestion ships and a backfill/reconciliation pass links them.
- Arsène's consumer contract test against pronos' endpoint can only validate shape
  today (via a Prism mock), not real content, since the endpoint returns stub/empty
  data until ingestion exists.

**Neutral / accepted**
- This is a real, acknowledged upstream dependency, not eliminated by this decision —
  only made non-blocking. It should be tracked as a known gap, not forgotten because
  v1 "works" on manual entry alone.

## Options rejected

| Option | Why not |
|---|---|
| Arsène owns fixture ingestion instead | Would duplicate effort pronos already has partial groundwork for (a `games` table and API shape purpose-built for this), and puts kickoff-time-locking-relevant data ownership in the content system rather than the game system that actually depends on its correctness for scoring. |
| A third, independent shared fixtures service | Cleanest decoupling in theory, but pure additional infrastructure and cost for a two-consumer problem at this scale — not justified until there's evidence the two-owner-with-consumer model above is actually causing pain. |
| Shared Postgres schema/tables between Arsène and pronos | Explicitly rejected by the product owner — blocks independently rehosting the pronos game and independently swapping the CMS later. |

## Revisit when

Pronos ships its fixture-ingestion slice — at that point, design the reconciliation
path (linking manually-entered Arsène pronos-article content to real pronos game rows)
as its own small piece of work, and confirm whether the consumer contract test can move
from a Prism mock to a real staging-environment check.
