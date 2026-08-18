# arsene-cms — Verify gate, sixth pass (v6)

**Status: NOT PASSED — this pass's own fix dropped a load-bearing case a
second time (an article whose only cover is a rejected upload now publishes
live with no cover image at all), and the residual `05-verification.v5.md`
§6.3/`04-green-evidence.v6.md` §6.3 described as "narrow and non-deterministic"
is proven, independently, by two agents, to be neither.**
**Run:** 2026-08-16 through 2026-08-18 (three session interruptions —
one usage-limit, one weekly-limit — across all three verify agents; each
resumed from its own transcript and the work is continuous, not restarted),
branch `feat/arsene-cms`, against commit `05badd6` (green remediation v6:
216/216, closing M-V5-01 through M-V5-05 and M-V3-04).
**Method:** `bob-security-auditor`, `bob-perf-analyst` and an integration/e2e
runner, run fresh and independently in parallel, each briefed to adversarially
re-derive the rewritten publish-readiness gate from scratch — not just
replay the specific exploits the prior five findings were built to close —
and to chase the green-v6-acknowledged residual to a concrete verdict. Plus
an instrumentation proof run by hand (Bob).

---

## 0. Executive summary

- **Four of the six targeted findings are cleanly closed, confirmed
  independently by all three agents against real infrastructure**: M-V5-04
  (idempotency key collision), M-V5-05 (duplicate-title slug collision, the
  deterministic case), and M-V3-04 (CDN origin configurability) all hold up
  under adversarial re-testing, including at the real spawn boundary — the
  exact leg that silently reopened a previous finding (H3) two verify passes
  ago, and therefore the one this gate trusts least by default.
- **The readiness-gate rewrite (M-V5-01/02/03) is correctly redesigned in
  principle but incomplete in practice — this is the third consecutive pass
  where this specific fix family has dropped a case it didn't test for.**
  Both the security auditor and the e2e agent, working independently,
  constructed the same new bug: **an article whose only cover row is a
  synchronously-rejected upload now publishes live with an empty cover
  image** — two ordinary product calls, no attacker, no direct database
  access. The e2e agent proved it's a genuine regression with an A/B on
  identical data (v5's tree correctly refuses this with `409`; v6's doesn't)
  and traced the exact dropped clause: v5's predicate had a third condition —
  "is there still a *usable* cover beside this one" — that v6's rewrite
  correctly stopped keying on `role` (closing M-V5-03) but lost entirely
  rather than replacing.
- **The two agents disagree on severity, both with real reasoning, and
  that disagreement is preserved below rather than collapsed**: the security
  auditor calls it Medium (product-correctness, no attacker required, but
  not a security boundary — no data leak, no privilege escalation). The e2e
  agent calls it High, arguing severity should track failure direction: every
  finding in this six-cycle saga so far has failed *closed* (wrongly blocked
  a legitimate action); this is the first one that fails *open*, silently, to
  the public internet, with `article_published` telemetry firing as if it
  were a success.
- **The residual green v6 itself flagged (§6.3) — a writer influencing which
  image row gets treated as "superseded" by flipping `role` before
  uploading — is real, and its "narrow, non-deterministic" characterization
  is wrong.** Both the security auditor and the e2e agent, independently,
  found that the outcome is fully controllable: the security auditor by
  reducing the demote's match set to exactly one row first (vacate the real
  cover's `role`, so only the target remains `role='cover'`); the e2e agent
  by exploiting Postgres's actual (undocumented but consistent) heap-scan
  ordering. Both converge: this is a deterministic, repeatable bypass of
  AC-08, not an opportunistic one.
- **A genuinely mitigating finding, found by the security auditor, that
  should correct the record across three consecutive verify documents**:
  the paste sanitizer's tag allowlist contains no `<img>` and no `<figure>` —
  so a `role='body'` image is never rendered to a visitor under any
  circumstance. The "genuinely embedded broken image" scenario this entire
  fix family (M-V4-01 through M-V6-02) has been reasoning about and testing
  against does not describe anything a real visitor can see. This doesn't
  make the underlying bugs not-bugs (the *server-side* state and controls
  are still wrong), but it means the real-world blast radius is smaller than
  every document in this family, including this one's predecessors, assumed.
- **No performance regression, and a helpful correction to how the new
  `takenSlugs()` query actually behaves**: it runs once per article's
  lifetime (first publish only, not every publish), costs +0.72ms today and
  projects to a worst case of ~14ms (2.9% of budget) at a 100,000-article
  archive this system isn't plausibly reaching for over a decade at 10x
  sustained growth. One non-urgent scaling note recorded for whoever next
  touches slug generation, not something to fix now.
- **A useful correction to the standing backlog**: the security auditor
  confirmed, at the RLS/grant level, that `M-V3-03` (direct-PostgREST lock
  bypass, carried as "still open" since v3) is actually closed — migration
  `0003` revoked the relevant columns and nobody re-checked since. Also, N5
  (the NUL-byte-in-title 500) was rediscovered by this pass's higher-depth
  fuzzing after v5's fuzzing missed it, settling N5b's suite-non-determinism
  question with a concrete data point.
- **The instrumentation proof succeeds**, including specifically confirming
  two same-titled articles both publish with correct, distinct telemetry —
  the exact case M-V5-05 was about.

---

## 1. `bob check verify` — precondition

Fresh `npm test` at the start of this pass confirmed **216/216** (after one
transient flake on the first attempt, resolved on re-run — consistent with
the concurrent-load pattern seen in every prior pass), `tsc --noEmit` clean,
matching `04-green-evidence.v6.md`'s claim exactly. Correct gate to run.

**Process note**: all three verify agents were interrupted mid-run twice —
once by a session usage limit, once by a weekly usage limit — across the
roughly two-day span this pass took to complete. Each was resumed from its
own transcript with an explicit instruction not to lose whatever thread it
was mid-investigation on (this mattered concretely: the e2e agent was cut
off mid-way through chasing down what it had labeled "E1", which turned out
to be the H-V6-01/M-V6-01 finding both agents converged on independently).
No work was lost; every reported measurement and exploit trace below was
completed and verified in a continuous session after the final resume, not
reconstructed from a partial run.

---

## 2. H-V6-01 / M-V6-01 — a regression this pass introduced: an article whose only cover is a rejected upload publishes live with no cover image

**Found independently by both the security auditor and the e2e agent.**
Proven by the e2e agent with an A/B on identical seed data across the v5 and
v6 trees, isolating this as a genuine regression rather than a pre-existing
gap:

```
1. POST /v1/articles                    -> 201
2. POST .../publish (no images yet)     -> 400 COVER_IMAGE_REQUIRED   <- correct
3. POST .../images (truncated cover)    -> 201 {"status":"failed","failure":"CORRUPTED_FILE"}
4. POST .../publish                     -> 200                        <- WRONG

--- v5 (b159caa) --- publish_status 409 IMAGE_NOT_READY, article_status "draft"     PASS
--- v6 (05badd6) --- publish_status 200, article_status "published", image [""]     FAIL
```

**Public impact**, confirmed against the real render pass: `<meta
property="og:image" content="">`, schema.org `NewsArticle` with `image:
[""]`, the homepage card renders with no `<img>` element at all (AC-06,
silently defeated), the article is written into the sitemap, and
`article_published` telemetry fires as though the publish were a normal
success.

**Root cause, traced precisely by both agents to the same line.** v5's
predicate (`isRejectedAttempt`, since replaced) had three conditions:
`role === 'cover'`, `status === 'failed'`, and — the clause that mattered
here — `images.some(other => other.role === 'cover' && other.status !==
'failed')`, i.e. "is there still a *usable* cover beside this one". v6's
`articleDependsOn()` correctly stopped reading `role` at all (that was the
fix for M-V5-03), but the "is there still a usable cover" guard didn't
survive the rewrite in any form — it was dropped, not replaced. The rejected
row still satisfies `COVER_IMAGE_REQUIRED`'s check (`images.some(i => i.role
=== 'cover')`, which the rejected row trivially passes), while the readiness
gate now separately and correctly excludes that same row from blocking
publish. The two checks, which used to agree by construction, now disagree,
and `publishNow()` falls through to `cover_image_url: ... ?? ''` — a branch
`04-green-evidence.v6.md` §4.2 describes as "unreachable... defensive typing,
not a path." It is now a reachable path.

**Both agents confirm the bug is directional, not general**: six adversarial
attack shapes tried by the e2e agent to find the *dangerous* direction (a
genuinely-still-needed broken image escaping the block) all held — a control
`409` still blocks correctly; a plain new-cover upload doesn't excuse the old
one (the demote correctly names the real cover); a row superseded while
`processing` can never have been embedded (no servable URL to begin with, so
excluding it is safe); and a row that reached `ready` cannot be forced back
to `failed` (the callback refuses to flip a settled row, `409 CONFLICT`,
confirmed live). **This specific new bug — H-V6-01/M-V6-01 — is the only
reachable "excluded when it shouldn't be" case found**, and it's reachable
via `COVER_IMAGE_REQUIRED`'s inconsistency with the readiness gate, not via
the gate's core adoption/supersession logic being wrong.

**Fix, as both agents converge on**: make `COVER_IMAGE_REQUIRED` and the
readiness gate agree on one notion of "has a cover" — require a *usable* one
on both sides (`images.some(i => i.role === 'cover' && articleDependsOn(i,
images))`), and pin the invariant the security auditor names explicitly as
what should have caught this and the §2.2 case green v6 already found and
fixed on its own: **a publish that returns 200 must always have a non-empty
`cover_image_url`.**

### Severity — presented as both agents argued it, not collapsed to one label

| Position | Reasoning |
|---|---|
| **Medium** (security auditor) | No attacker required, but this is product-correctness — a blank/broken image on a public page, not a security boundary. No data leak, no privilege escalation, no credential exposure. Fails open on *presentation* only. |
| **High** (e2e agent) | Severity should track failure direction, not just presence of an attacker. Every finding in this family so far — M-V4-01 through M-V5-05 — failed *closed* (wrongly refused a legitimate publish). This is the first one that fails *open*: it silently succeeds, publishes to the public internet, and telemetry records it as a normal success with no signal anything went wrong. |

Both readings are defensible and neither changes the gate outcome — this
blocks either way. Recorded as a genuine disagreement rather than
arbitrated, since the underlying facts (exploit, root cause, fix) are not in
dispute between the two agents, only the label.

---

## 3. M-V6-02 — the green-v6-acknowledged residual, proven deterministic by two independent methods

`04-green-evidence.v6.md` §6.3 explicitly disclosed, as a known and accepted
residual: a writer can still influence *which* image row gets treated as
"superseded" (and thus excluded from blocking publish) by flipping a target
row's `role` to `cover` via the one direct-PostgREST grant writers have,
before uploading a replacement cover — described there as "narrower than
v5's gap, bounded, **non-deterministic** (depends on which row `returning
id` yields first)".

**Both verify agents chased this to a concrete verdict and both concluded
the "non-deterministic" characterization is wrong.**

**Security auditor's construction** — reduce the demote's match set to
exactly one row first, removing the ordering question entirely:

```
draft: cover A (ready) + body image B (adopted, failed, referenced from body_html)
publish                                          -> 409 IMAGE_NOT_READY     (AC-08 working)

as `authenticated`, direct PostgREST, the only image grant that exists:
  update article_images set role='body'  where id = A     -- vacate the slot
  update article_images set role='cover' where id = B     -- put the target in it

POST .../images  role=cover  (an ordinary good file)
  -> demoteCurrentCover matches EXACTLY ONE row (B); `returning id` is forced
  -> new cover Z.replaced_cover_image_id = B          (true on every run)

publish                                          -> 200, article live
```

No race, no retry, no ordering dependence — by construction there is only
one row to match, so there is nothing left to be non-deterministic about.

**E2e agent's independent construction** — instead of avoiding the ordering
question, it directly measured what the ordering actually is:

```
D3a: broken row inserted AFTER the cover:  0/6 published broken
D3b: broken row inserted BEFORE the cover: 5/6 published broken  ("named broken")
```

Postgres's heap scan follows insertion order, consistently, not chance — so
even the two-matching-rows variant §6.3 describes as unreliable is, in
practice, reliable in a specific and controllable direction once the
attacker controls insertion order (which they trivially do, since they
control the sequence of their own uploads).

**Verdict, converged on independently by both agents**: "narrower than v5's
gap" and "bounded" are both accurate — this needs a valid writer credential,
targets a single article's cover slot, and (per §4 below) has a smaller
real-world payoff than previously assumed because of the sanitizer finding.
**"Non-deterministic" / "not a reliable technique" is incorrect and should
be struck from the record.** This is a deterministic, repeatable bypass of
an advertised integrity control (AC-08), using the one grant writers
actually have.

**Severity: Medium**, per the security auditor's assessment (not
independently re-argued by the e2e agent, which treated this as
corroboration of the auditor's primary finding rather than its own).

**Fix, already named in green v6's own evidence doc and endorsed by the
security auditor's ruling**: `revoke update (role) on article_images from
authenticated;` — one expand-only migration line, the same pattern
`0003_lock_columns_service_role_only.sql` already set for the lock columns.
Must land together with a server-side route for cover selection (recorded
below as L-V6-01), since revoking the grant removes the only mechanism a
writer currently has to designate an image as the cover.

---

## 4. I-V6-01 — a finding that corrects the record across three verify documents, not a new bug

Found by the security auditor while adversarially probing the readiness
gate: `src/domain/paste.ts`'s sanitizer allowlist (`ALLOWED_TAGS`) contains
**no `img` and no `figure`**. `publishArticle.ts` sanitizes `body_html`
before persisting it; `render.ts` sanitizes again before interpolating.
**A `role='body'` image row has no rendering path anywhere in this codebase
— it is never shown to a visitor, under any circumstance, regardless of its
status.**

This means the framing carried through `05-verification.v5.md` §3.2,
`04-green-evidence.v6.md` §2.1, and this document's own §2-3 above — "an
image the article is genuinely still using and *referencing from its body
HTML*" — describes a state that cannot actually be rendered. Verified live
by the security auditor: after constructing the M-V6-02 exploit end to end,
the `<figure><img>` a visitor would need to see is simply absent from the
rendered page.

**This does not make M-V6-01 or M-V6-02 non-issues.** The server-side state
is still wrong (a "broken, still-in-use" row is still misclassified, or the
cover slot is still hijackable), the `409 IMAGE_NOT_READY` control still
exists to be honored, and AC-08 is a real, stated acceptance criterion
independent of what the current sanitizer happens to render. But it means
the practical stakes of the *body*-image half of this entire fix family are
lower than every document up to and including this one assumed — worth
recording plainly rather than let three consecutive documents keep
describing an unreachable state as the motivating scenario.

---

## 5. Disposition of the four cleanly-closed findings

Confirmed independently by at least two agents each, against real
infrastructure — not by trusting the diff.

| Finding | Verdict | Strongest evidence |
|---|---|---|
| M-V5-01 (rejected body image blocks forever) | **CLOSED** | Both agents: rejected body upload on a live article → republish 200 |
| M-V5-02 (processing cover demoted then async-failed) | **CLOSED** | Both agents, via the real Lambda-status callback: adopted+processing cover superseded, real callback reports it failed → publish still succeeds |
| M-V5-03 (role-flip bypass, the exact v5 reproduction) | **CLOSED** for the exact reproduction; **residual reopened as M-V6-02** (§3 above) | A bare `role` flip alone, with no supporting upload, still correctly gets `409` |
| M-V5-04 (idempotency key collision) | **CLOSED** | Both directions verified from database state, not just responses; genuine same-operation replay still works; e2e agent additionally found a `409` refusal isn't wrongly cached — retrying after fixing the cause still succeeds |
| M-V5-05 (duplicate-title slug collision) | **CLOSED** (deterministic case) | E2e agent: 6 same-titled articles → 6 distinct slugs correctly disambiguated, including nested collision families ("Match Report 2" as a literal title vs. as an auto-generated disambiguation) never interfering. Security auditor's slug-race variant (§7 below) downgrades from "permanent 500" to "transient, retry recovers" |
| M-V3-04 (CDN origin hardcoded) | **CLOSED**, verified at the real spawn boundary | Both agents: a configured non-`.example` origin is genuinely threaded through `ServerOptions` → spawn `env` → `serverMain.ts`; the placeholder is correctly refused both before *and* after a real origin is configured (doesn't become permanently accepted); suffix/prefix/userinfo confusion all correctly refused |

**Correction to the standing backlog, found by the security auditor while
verifying the readiness gate's signals are genuinely server-controlled**:
`M-V3-03` (direct-PostgREST lock bypass), carried in every verify document
since v3 as "still open", is actually **closed** — migration `0003`
(`0003_lock_columns_service_role_only.sql`) revoked write access to
`locked_by`/`locked_at` and this was never re-checked afterward. Confirmed
live: both columns refuse `authenticated` with `42501`. The backlog line
should be struck.

---

## 6. Performance — no regression, one corrected assumption, one non-urgent note

Full detail: perf agent's report, folded in here. **Important correction to
how this pass's brief characterized the new query**: `takenSlugs()` does
**not** run on every publish — `publishArticle.ts`'s call site is `slug:
article.slug ?? (await uniqueSlug(...))`, so it only runs on an article's
*first* publish, when it has no slug yet. Every republish skips it entirely.
The perf agent proved this empirically (the republish arm's latency is flat
across a 700x change in archive size) rather than just reading the code.

### 6.1 `takenSlugs()`'s cost

End-to-end over real HTTP, first-publish (runs the query) vs. republish
(skips it), interleaved A/B at three archive sizes:

| Archive size | First publish p50/p95 | Republish p50/p95 | Delta (the query's real cost) |
|---|---|---|---|
| 144 articles (today) | 7.20/38.42ms | 6.48/15.51ms | +0.72ms p50 |
| 10,288 articles | 6.87/31.52ms | 5.09/7.57ms | +1.78ms p50 |
| 100,432 articles | 20.37/48.41ms | 6.03/16.65ms | +14.34ms p50 |

All comfortably inside the <500ms warm p95 publish budget (worst case
42.9ms total, 8.6% of budget) at every size tested. Isolated query
measurement confirms the shape is a real O(archive-size) full-table scan
(the `LIKE 'prefix%'` predicate under `en_US.utf8` collation isn't
index-able by the existing unique index) — but it costs each article
exactly once, not per-publish, and the growth projection against
`02-architecture.v1.md` §4's stated 10x-growth scenario puts even the 100k
worst case (2.9% of budget) over a decade away. **Not worth fixing now**,
same standard v5 applied to `render.ts`'s comparable O(archive) trend — but
recorded precisely (§6.2 below) so a future touch to slug generation can
pick up a free, no-migration improvement if it's already in the area.

### 6.2 The three other changes — all free or better

- **Readiness gate rewrite**: still short-circuited to zero invocations on
  any healthy publish (confirmed by instrumentation, not assumed). Worst
  case (every image non-ready, k=1000 orphan rows): 2.2µs — 0.0004% of
  budget.
- **`getArticleImages`'s two extra selected columns**: free at any
  realistic row count (+0.28ms at k=1000).
- **Idempotency namespace**: +43 nanoseconds per lookup. Free.
- **`demoteCurrentCover()` losing its `status <> 'failed'` predicate**: the
  dropped predicate was never index-friendly (confirmed via `EXPLAIN
  ANALYZE` — it was a heap filter both before and after), so removing it is
  measurement-noise-to-marginally-faster, not a regression.

### 6.3 Existing budgets, re-confirmed

| Area | Budget | v5 | v6 measured | Verdict |
|---|---|---|---|---|
| Publish, warm | p95 < 500ms | p50 4.93/p95 8.70ms | p50 6.1-17.7/p95 29.2-42.9ms (across archive sizes) | PASS, ≤8.6% of budget |
| Publish, cold | < 2s | 31.9-47.5ms | 34.0-86.6ms, worst single 257.8ms @100k | PASS, ≤13% |
| Image conversion, near cap | < 15s | 1.28-1.35s | 1.31-1.39s | PASS, 9.3% |
| Public render, N=1000 | < 200ms | home 5.9-6.5/cat 4.0-5.2ms | home warm p50 7.47/p95 15.0ms | PASS, ≤7.5% |
| Lock/heartbeat write | < 50ms | p50 0.41/p95 0.81ms | p50 0.502/p95 0.864ms | PASS, 1.7% |

Small increases across the board versus v5 are attributed to genuine
background machine load during this pass (documented explicitly by the perf
agent — concurrent agent work drove 1-minute load averages of 4-13 on 8
cores during the HTTP runs) rather than any code change; neither `render.ts`
nor the lock-write path was touched this pass, and the isolated,
load-independent query measurements agree within noise across two runs
taken under different load conditions. `NFR-IMGCPU-01` did not flake in any
run.

---

## 7. Further findings, Low/Info

### L-V6-01 (Low) — `CDN_ORIGIN` is configurable but never validated
Security auditor: a trailing slash, path suffix, missing scheme, or
uppercase host in the configured origin each silently reproduce M-V3-04's
original symptom (every callback refused, every image stuck `processing`,
every publish `409` forever) — the fix made the value configurable but not
safe to misconfigure. `serverMain.ts` already has a precedent for failing
closed on a bad security-relevant env var (the missing-JWT-secret check);
the same one-line pattern applies here. Should land together with M-V6-02's
migration, since M-V6-02's fix removes the only writer-facing way to set a
cover and a route will need to replace it — natural to validate the origin
in the same pass.

### L-V6-02 (Low) — two `ready` cover rows: publish and the render pass can independently disagree about which is "the" cover
Security auditor: `publishArticle.ts` picks the cover via an unordered
`.find()`; `render.ts` picks it via `limit 1` with no `order by`. Two
independent, unordered picks over the same possible-multi-row state
(reachable with one `role` flip) can select different rows — the
`structured_data`/`og:image` baked in at publish time and the `<img>` the
homepage renders later could show different images. Same class as v5's
L-V5-02 (two sources of truth deciding one value independently). Fix:
`order by created_at desc limit 1` in both places, or persist a single
`cover_image_id` column.

### L-V6-03 (Low, downgraded from a prior concern) — the slug-generation race is real but transient, not permanent
Green v6 §6.5 recorded the deterministic duplicate-title case (M-V5-05) as
fixed but flagged a residual concurrent-write race. Both agents reproduced
it directly (four concurrent same-titled publishes → one `500` among three
`200`s), but the e2e agent additionally showed the failure **recovers on a
plain retry** (a second attempt after the race succeeds normally) — a
materially better failure mode than M-V5-05's original permanent 500. Not
urgent; worth a line if the idempotency/retry story is ever revisited.

### Corrected/settled from the standing backlog
- **M-V3-03**: closed, not open — see §5 above.
- **N5** (NUL byte in `title` → 500): rediscovered by this pass's
  higher-depth fuzzing (5,035 generated cases) after v5's equivalent fuzzing
  run did not surface it — this is the concrete data point N5b's
  "suite-non-determinism" concern was describing, now observed directly
  rather than inferred. Still not in scope for a fix; still fails safe.
- **N2** (internal contract's `optimized_url` schema wider than the
  implementation's origin check): reconfirmed present and reclassified
  slightly by the e2e agent — it's a contract-expressiveness gap (no
  version of the `format: uri` constraint can express "must match a
  runtime-configured origin"), not new, and the internal contract isn't
  fuzzed by the committed suite at all.

---

## 8. Instrumentation proof, sixth pass

Run by hand by Bob, real Postgres 16, real spawned server. This pass
specifically rewrote the publish path (readiness gate + the new
`takenSlugs()` query), so the primary path was re-exercised with the exact
scenario M-V5-05 was about — two same-titled articles — to confirm
telemetry survives correctly through both:

```
--- publishing two articles with the SAME title, through the real handler ---
article A: 200 instrumentation-proof-v6-duplicate
article B: 200 instrumentation-proof-v6-duplicate-2
both 200: true
slugs distinct: true

telemetry rows for both articles:
  A: draft_started @ ...20:11:57.715Z, article_published @ ...20:11:57.773Z
  B: draft_started @ ...20:11:57.785Z, article_published @ ...20:11:57.925Z
article A has both events: true
article B has both events: true

HAND-COMPUTED time-to-publish (article A) = 0.0010 minutes
```

Both articles publish successfully with correctly disambiguated, distinct
slugs, and each produces complete, correctly-attributed telemetry. Metric
remains computable, counter-metric unchanged, still the documented honest
gap from v1-v5.

---

## 9. Tooling — clean, with one long-standing open question finally answered

- **semgrep**: 0 findings on `src`/`db`/`scripts` (213 rules, 30 files). The
  question v4 and v5 both flagged but didn't resolve — whether semgrep's
  default ignore file was silently skipping `tests/` — is answered this
  pass: **it was**. `semgrep tests/` and `--include='tests/**'` both report
  `Targets scanned: 0`; the working invocation is scanning a copy of the
  directory outside the ignored path, which yields **46 files genuinely
  scanned, 0 findings**. Both prior passes' claimed tests-directory scans
  were silent no-ops; the directory itself is, now confirmed, clean.
  Recording the working invocation here so it isn't re-discovered a third
  time.
- **gitleaks**: all hits (working tree + 22-commit history) confirmed
  false-positive test fixtures or doc-comment text. No real secret.
- **`npm audit --omit=dev`**: 0 vulnerabilities.
- **Full suite**: 216/216, confirmed by all three agents across five
  separate full runs (including one against a pristine `git archive HEAD`
  export, specifically to rule out worktree contamination — see below).
  `tsc --noEmit`: clean on the committed tree.
- **Contracts at depth**: 5,035 generated cases from the e2e agent's
  standalone Schemathesis run, targeting `publishArticle` (1,555 cases) and
  `uploadArticleImage` (631 cases) specifically since both were touched this
  pass. Nothing new found in the changed code — the two failures
  encountered (N5, N2) are both pre-existing and already tracked.

### Workspace hygiene — recurring for a third consecutive pass, and this time it actually broke a gate command
Both the security auditor and the e2e agent independently hit the same
hazard v4 §8/I-V4-04 and v5 §7 first flagged: a concurrently-running perf
agent's own untracked `tests/perf/` directory was present in this shared
worktree for parts of this pass. This time it wasn't just a risk —
`npx tsc --noEmit` genuinely failed (exit 2, 19-20 errors) with the
directory present, because those files are picked up by `tsconfig.json`'s
include glob. Both agents confirmed the committed tree itself is clean by
testing against a pristine `git archive HEAD` export (`tsc` exit 0 there).
Recording again, a third time: this needs a `.gitignore` entry or an
enforced out-of-repo scratch convention for agents working in this shared
worktree, not another note in a verify document.

---

## 10. Gate verdict

**NOT PASSED.**

Four of the six targeted findings — M-V5-04, M-V5-05, M-V3-04, and (for its
exact reproduction) M-V5-03 — are genuinely, thoroughly closed, confirmed
independently by every agent involved.

What blocks: this pass's core fix — the readiness-gate rewrite — is
correctly redesigned in principle (it stopped keying decisions on a
writer-controllable column, which was the right call and closes M-V5-03's
literal reproduction) but, for the third consecutive pass in this specific
fix family, dropped a case it wasn't explicitly tested against
(H-V6-01/M-V6-01). And the residual green v6 itself disclosed as accepted
(§6.3) turns out to be mischaracterized in a way that matters: not
"non-deterministic and bounded" but deterministic and repeatable, per two
independent constructions (M-V6-02).

The mitigating context matters and is recorded plainly rather than buried:
the sanitizer finding (I-V6-01) means the body-image half of this fix
family's stakes are lower than assumed across three documents, all four
non-image findings this pass targeted are solidly closed, and performance
shows no regression anywhere. This is not a pass that failed broadly — it's
one specific rewrite that needs one more iteration, plus one accepted
residual whose fix was already correctly identified in green v6's own
evidence but not yet taken.

**Recommended next cycle, in order:**
1. **H-V6-01/M-V6-01**: reconcile `COVER_IMAGE_REQUIRED` and the readiness
   gate on one notion of "usable cover", and — per both agents' explicit
   recommendation — add a test that pins the invariant directly (`200 ⇒
   non-empty cover_image_url`) rather than continuing to enumerate specific
   states, since that's the pattern that's now let two different cases slip
   through two different rewrites of the same function.
2. **M-V6-02 + L-V6-01, as one change**: the `role`-grant revocation
   green v6 already named, paired with a server route for cover selection
   (since the revocation removes the only mechanism writers currently have)
   and origin validation for the newly-configurable `CDN_ORIGIN`.
3. Then L-V6-02 (single source of truth for "the cover"), L-V6-03 (the
   transient slug race), and the still-standing idempotency-store TTL/
   `writer_id`-scoping items carried since v4/v5.

`state.json` left untouched, per the established pattern.
