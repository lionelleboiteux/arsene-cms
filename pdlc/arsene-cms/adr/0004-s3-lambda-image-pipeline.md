# ADR-0004: Move image optimization from the Supabase Edge Function to S3 + Lambda

- **Status:** accepted
- **Date:** 2026-08-12
- **Unit:** arsene-cms
- **Deciders:** Lionel Le Boiteux, Bob

## Context

Verify-gate finding #5 (`05-verification.v1.md` §5): timed against genuine
6-12MP photos rather than the test suite's degenerate padded fixtures, the
WASM JPEG/PNG codec in `src/images/optimize.ts` takes 1.4-4.0 seconds — at or
above Supabase Edge Functions' documented 2-second CPU-time budget, for an
ordinary, contract-legal upload, not an adversarial one. This is a real risk
of production timeouts on normal writer uploads, not a theoretical one.

The root cause is the deployment target, not the code: Supabase Edge Functions
run on Deno, which ADR-0001 already noted rules out `sharp` (Node-native,
libvips-backed, fast) — forcing a WASM codec (`@jsquash/*`) that is
meaningfully slower for real photographic content, inside a runtime with a
hard 2s CPU ceiling per invocation that a background/async trigger does not
lift, since the limit is per-invocation, not per-request-latency.

Separately, the product owner asked about image storage limits while
reviewing the verify report. Storage size itself is not a real constraint at
this product's scale (a few dozen MB/month; even Supabase's 1GB free tier
would last 18-24 months) — but answering that question surfaced the
CPU-budget fix as the actual reason to move storage, not storage cost.

## Decision

Move the original-upload landing zone and the optimization step off Supabase
entirely: writer uploads still go to Arsène's own `POST /v1/articles/{id}/images`
Edge Function (auth, cover/body role, size-limit checks unchanged), which now
uploads the original file to an S3 bucket and creates an `article_images` row
with `status: 'processing'`, returning `201` immediately rather than waiting
for optimization. An S3 event notification on the originals prefix triggers a
Lambda function running real `sharp`, which decodes, converts to WebP/AVIF,
compresses, and uploads the result to a processed prefix in the same bucket.
Lambda then calls back into a small, separately-authenticated Arsène Edge
Function (`POST /internal/images/{id}/status`, not writer-bearer-token
protected — a distinct shared secret) to flip the row to `status: 'ready'`
with the optimized URL, or `status: 'failed'` with a reason. The editor polls
or subscribes (Supabase Realtime on `article_images`) until the row leaves
`processing`, exactly the state machine `article_images.status` was already
built to express.

`publishArticle.ts`'s existing `IMAGE_NOT_READY` check (AC-08: never publish
with a broken image) needs no change — it already treats anything other than
`ready` as not publishable, regardless of which system flips the status.

## Consequences

**Positive**
- Directly closes finding #5: Lambda's 15-minute execution ceiling and native
  `sharp` remove the CPU-budget risk entirely, with wide margin.
- `sharp` decodes every format the contract already advertises (JPEG, PNG,
  WebP, AVIF, HEIC) in one library — closes the rest of deviation D7
  (`04-green-evidence.v1.md` §6) for free, rather than adding a fourth WASM
  codec by hand.
- Writer-perceived upload latency improves: the Edge Function returns as soon
  as the original is stored, not after a multi-second synchronous encode.
- Runs entirely inside AWS's perpetual free tier (1M requests + 400K
  GB-seconds/month) at this product's volume — not a 12-month trial.

**Negative**
- A second cloud vendor enters an otherwise Supabase-only stack: a new AWS
  account, IAM roles (least-privilege: Lambda needs S3 read/write on this one
  bucket only, nothing else), and a second place credentials and deploys can
  go wrong. This is real, ongoing operational surface the sibling projects
  (pronos, DNP) don't carry.
- Processing is now asynchronous. The editor must handle a `processing` state
  visibly (not just internally) and cannot let a writer publish while any
  image is still processing — already true today, but now a more commonly-hit
  path rather than an edge case, since even a fast Lambda run has S3-event and
  cold-start latency a synchronous in-request call didn't.
- A new trust boundary: the Lambda-to-Arsène status callback is not protected
  by a writer's bearer token (Lambda isn't a writer), so it needs its own
  shared secret, distinct from `WRITER_TOKEN`, checked before any row update —
  otherwise anything that can reach that endpoint could mark an unprocessed or
  malicious image as `ready`. STRIDE-lite: Spoofing (mitigated by the shared
  secret, rotatable independently of writer credentials), Tampering (the
  callback can only move `processing`→`ready`/`failed` for the one `article_images.id`
  it names, never arbitrary columns).
- S3 lifecycle/cleanup for originals is a new small housekeeping concern (not
  urgent at this volume, but should not be forgotten indefinitely).

**Neutral / accepted**
- `CDN_ORIGIN` in `router.ts` was already an abstraction over "wherever the
  fronting CDN actually is" — it now fronts S3/CloudFront instead of Supabase
  Storage. No contract or public-site-facing shape changes; `render.ts` and
  the OpenAPI contract's `urls.original`/`urls.optimized` fields are unaffected.
  `NFR-EGRESS-01` (visitors never hit Supabase Storage directly) is satisfied
  the same way it always was — visitors never hit S3 directly either, only
  the CDN.

## Options rejected

| Option | Why not |
|---|---|
| Stay on Supabase Edge Function, downscale before encoding to fit the 2s budget | Treats the symptom, not the cause — still bounded by the same per-invocation ceiling, still stuck with the slower WASM codec, still missing WebP/AVIF/HEIC decode support. A real fix, not a workaround, was preferred given the gap was already blocking the gate. |
| Stay on Supabase, make processing async via `pg_cron` polling an Edge Function | Same 2s-per-invocation ceiling applies regardless of what triggers the invocation — doesn't fix the root cause, only hides the failure mode behind a retry loop. |
| A third storage-agnostic image API (e.g. Cloudinary, imgix) | Removes the CPU-budget problem entirely and adds no AWS account, but introduces a recurring per-image vendor cost and a third external dependency for a product that has otherwise been deliberately built at $0. Worth reconsidering if AWS's operational overhead turns out to be a bigger burden in practice than expected. |

## Revisit when

AWS's operational overhead (a second account, IAM, a second deploy pipeline)
turns out to cost more real time than the CPU-budget problem it solved — at
that point, a paid image API (rejected above) trades a recurring dollar cost
for removing that overhead entirely, and becomes worth re-litigating.
