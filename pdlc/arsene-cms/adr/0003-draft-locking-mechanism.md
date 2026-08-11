# ADR-0003: Whole-article draft locking via staleness-checked columns, not Realtime presence or CMS-native locking

- **Status:** proposed
- **Date:** 2026-08-11
- **Unit:** arsene-cms
- **Deciders:** Lionel Le Boiteux, Bob

## Context

AC-05 requires that when one writer has a draft open, a second writer sees it's locked,
by whom, and cannot edit until it's released — and per the product spec's assumptions,
this applies to the whole article, not individual sections. AC-01/AC-02 additionally
require autosave and crash recovery on the same drafts. The architecture exploration
found that the two features together (autosave + locking) are exactly where an
off-the-shelf approach broke: Payload CMS's native document locking is documented as
unreliable when autosave is enabled (upstream issues payloadcms/payload#11604,
#14477), a silent-data-loss risk. That option was rejected (ADR-0001), but the same
combination of requirements still needs a real mechanism in the chosen architecture.

## Decision

Implement locking as two columns on `articles` — `locked_by` (writer id) and
`locked_at` (timestamp) — updated via a heartbeat write from the editor SPA roughly
every 20 seconds. A lock is considered released if `locked_at` is older than a fixed
staleness threshold (60–90 seconds), which is also read to display "locked by X" to a
second writer. No Supabase Realtime presence channel, no CMS-native locking primitive.

## Consequences

**Positive**
- Self-heals the "writer's browser crashes" case (AC-05's implicit requirement,
  covered explicitly by the when-things-go-wrong table) automatically — a stale lock
  expires on its own, no admin unlock action needed for the common case.
- Simple enough to test deterministically with Testcontainers + a fake clock, reusing
  the same pattern pronos already uses for kickoff-time match locking.
- Avoids the exact bug class that ruled out Option B — this mechanism has no
  interaction with autosave beyond both writing to the same row, which is safe.

**Negative**
- Not real-time: a second writer only learns a lock was released after their next poll
  or heartbeat interval, not instantly. Acceptable at 2–5 writers and infrequent
  concurrent access, but would not scale to a much larger writer pool without revisiting.
- Same-writer-two-tabs is not covered — the lock is per writer, not per session, so a
  writer with the same draft open in two tabs can race themselves. Not in scope per the
  spec (which defines locking as "another writer" cannot edit), but worth writers
  knowing about if it causes confusion later.
- No admin "force unlock" exists in the spec; if the staleness window is ever too long
  in practice, there's no manual override — only the timeout.

**Neutral / accepted**
- The 60–90 second staleness threshold is a judgment call, not derived from an AC. It
  should be tuned based on real writer behavior after launch, not treated as fixed.

## Options rejected

| Option | Why not |
|---|---|
| Supabase Realtime presence channel | More moving parts (a stateful presence subsystem) for a benefit — instant lock-release visibility — that doesn't matter at 2–5 writers publishing a handful of articles a week. |
| CMS-native locking (Payload) | Documented broken in combination with autosave for exactly this spec's requirements (see Context) — ruled out at the architecture-option level, restated here since it's the same underlying decision. |

## Revisit when

The writer pool grows enough that heartbeat-interval-latency on lock visibility
becomes a real complaint, or if writers report being locked out longer than expected
due to the staleness window — either is a signal to consider Realtime presence or a
tunable/shorter interval.
