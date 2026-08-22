# Release evidence — v0.2.0

**Status: approved, not yet deployed.**

| Field | Value |
|---|---|
| Approved by | Lionel Le Boiteux (lionel.leboiteux@gmail.com), in chat |
| Approved at | 2026-08-22T21:05:00Z |
| Decision | approve — "Approve v0.2.0", no scoping |
| Tag | `v0.2.0` (annotated, local only — not pushed) |
| Commit SHA | `186adf92d0a223bf6268bfaba8e34fb52978f0a4` |
| Artifact digest | n/a — no build artifact produced; the Deno Edge Function deploys from source (`supabase functions deploy`), and migrations apply `db/migrations/*.sql` directly |
| Approval record | `APPROVAL.md`, sha256 `abf11641c6940c9100f1de131e1b7c511613067c640ebf51039c7c1a0dc745c6` |

## What was deployed

**Nothing.** This repository has no git remote configured, so
`.github/workflows/deploy.yml` cannot run — there is no tag to push and no
CI to trigger against. The approval in `APPROVAL.md` covers the release
content; it is not itself a deploy action, and none was taken.

## What was observed

Not applicable — no deploy occurred. The last real, observed behavior is
the local rehearsal recorded in `pdlc/arsene-cms/10-pipeline.v2.md` §2 (real
Deno process, real Postgres, real HTTP, a measured 1.502s timeout) and
`pdlc/arsene-cms/11-dashboard.v1.md` §3 (real `serverMain.ts` process, real
seeded Postgres, the dashboard adapter answering correctly) — both against
disposable local infrastructure, not the real linked Supabase project.

## Was a rollback needed

Not applicable — nothing was deployed to roll back from.

## Next update to this file

Once a remote exists and the deploy actually runs (per `APPROVAL.md`'s
"Deploy status" section — a GitHub repo with `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, `SUPABASE_DB_URL` configured, and the Edge
Function's own runtime secrets set via `supabase secrets set`), this file
should be updated with: the real workflow run URL, what the deploy job
actually observed (migration apply output, Edge Function deploy output),
the specific signals watched per the architecture document for the agreed
window, and whether a rollback was triggered.
