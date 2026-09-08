---
name: import-wix-articles
description: Import a batch of Wix blog posts into Arsène as review-ready drafts, via the Wix MCP connector and scripts/wix-import/.
---

# Import Wix articles into Arsène

Arsène replaced Wix as the CMS; this is the repeatable procedure for pulling
a batch of existing Wix blog posts across as drafts for a human to review
and publish. Nothing here ever auto-publishes — every imported article
lands as `status: draft`, the same bar any other draft clears before it
goes live.

The reusable logic lives in `scripts/wix-import/`:
- `convertRicos.ts` — Wix's Ricos rich-content JSON → the HTML Arsène's
  body editor stores (`h2`/`h3` headings, `p`, `ul`/`ol`/`li`, `strong`,
  `em`, `u`, a hex-colour `span`, `a href`, and `IMAGE` nodes as
  placeholders). Has its own unit tests
  (`tests/unit/wixImportConvertRicos.test.ts`) built against real Wix
  document shapes — run them after any change here.
- `categoryMap.ts` — Wix category id → Arsène league/type name. Extend
  this, not `importPosts.ts`, when a new league or content type shows up.
- `importPosts.ts` — the CLI driver. Idempotent by slug (skips an article
  whose slug already exists), sequential taxonomy resolution (no races on
  creating the same league/category twice), uploads every image through
  Arsène's real pipeline and polls until it's `ready` before saving
  `body_html`.

## Step 1 — find out what's new

The Wix MCP connector (`mcp.wix.com`) is agent-only — there's no script for
this part. If it's never been authorized in this session, `/mcp` walks
through the OAuth grant.

1. `ListWixSites` to get the `siteId` (site name: "Fantasy Coach").
2. `CallWixSiteAPI`, `POST /v3/posts/query`, body
   `{"fieldsets": ["URL"], "query": {"filter": {"firstPublishedDate": {"$gt": "<ISO date of the last import>"}}, "paging": {"limit": 50}}}`
   — lists every post published since the last batch, with `id`, `slug`,
   `categoryIds` and the cover `media`, but *not* the body (keeps the
   response small). Cross-check each `slug` against Arsène
   (`articles?slug=eq.<slug>`) or just let `importPosts.ts` skip duplicates
   itself later — don't rely on title matching, Wix reuses similar titles
   across weeks (e.g. "Player Picks, Ligue 1, J1").

## Step 2 — fetch each post's full content, one at a time

`POST /v3/posts/query` with `fieldsets: ["RICH_CONTENT"]` across more than
2-3 posts at once reliably exceeds this tool's ~50,000-character response
cap and gets silently truncated mid-JSON (confirmed twice during the first
import — the saved "overflow" file is *also* truncated, not a full
fallback). Fetch one post at a time instead:

```
GET https://www.wixapis.com/v3/posts/{postId}?fieldsets=RICH_CONTENT
```

Each response comes back inline (a single post's rich content has stayed
well under the cap every time so far — the largest observed was ~30KB).
Save each raw `{"post": {...}}` response to its own file under
`scripts/wix-import/data/raw/<postId>.json` as it's fetched (via the Write
tool) — don't hold all of them in context before writing, and don't try to
batch multiple posts' rich content into one query call.

**Watch for empty `categoryIds`.** At least one real post
("Player Picks, Ligue 1, J1") was published with no categories assigned in
Wix itself — not a fetch error. `importPosts.ts` skips a post whose
categories don't resolve, with a clear reason in its output; if a skip like
that is actually just a same-series sibling missing its tags (compare
against the other posts in that series — same title pattern, same
league/type), fix `categoryIds` by hand in the batch file to match its
siblings rather than leaving it skipped or guessing blindly.

## Step 3 — build the batch file and check it against the converter

Consolidate the raw per-post files into the array `importPosts.ts` expects
— each entry: `{ id, title, slug, categoryIds, richContent, media }` (drop
everything else Wix returns; `importPosts.ts`'s `WixPost` type is the
source of truth for the shape). Save it to
`scripts/wix-import/data/batch-<date>.json`.

Before running the real import, sanity-check the conversion and taxonomy
resolution against the actual batch — cheap, and it's where a new Ricos
node type (a real `HEADING` node, `BULLETED_LIST`, a `LINK` decoration —
all three showed up partway through the first real batch, none were in the
original single-sample design) or an unmapped category shows up first:

```bash
node --experimental-strip-types -e '
import("./scripts/wix-import/convertRicos.ts").then(async ({ convertRicosToHtml }) => {
  const { resolveTaxonomy } = await import("./scripts/wix-import/categoryMap.ts");
  const fs = await import("node:fs/promises");
  const posts = JSON.parse(await fs.readFile("scripts/wix-import/data/batch-<date>.json", "utf8"));
  for (const post of posts) {
    const { html, images } = convertRicosToHtml(post.richContent);
    const tax = resolveTaxonomy(post.categoryIds);
    console.log(post.slug, "| html:", html.length, "chars |", images.length, "images | taxonomy:", tax.league_name, "/", tax.type_name);
  }
});
'
```

If `resolveTaxonomy` returns `null`/`null` for a post whose category really
is new (not the missing-tags case above), add a mapping to
`categoryMap.ts`'s `LEAGUE_PRIORITY`/`TYPE_PRIORITY` tables rather than
special-casing it in the script.

If the converter's output looks wrong for a node shape it hasn't seen
before, fix `convertRicosToHtml` and add a test to
`tests/unit/wixImportConvertRicos.test.ts` using the real fetched shape
(not an invented one) before re-running the check above.

## Step 4 — run the import

```bash
SUPABASE_URL=https://wpicvtlfjhdofpmfdzrb.supabase.co \
SUPABASE_ANON_KEY=... \
SUPABASE_SERVICE_ROLE_KEY=... \
ARSENE_API_BASE=https://wpicvtlfjhdofpmfdzrb.supabase.co/functions/v1/arsene-api \
ADMIN_EMAIL=racc.leraccoon@gmail.com \
  node --experimental-strip-types scripts/wix-import/importPosts.ts scripts/wix-import/data/batch-<date>.json
```

Never put the service-role key directly in a shell command you're about to
run through a tool call — write it to a local, gitignored `.env.local` (see
`.gitignore`'s `.env`/`.env.local` entries) and `source` it instead.

Prints one line per post (`imported as <id>` or `skipped: <reason>`) plus a
final summary. Safe to re-run on the same file — already-imported posts are
skipped by slug, not re-created or duplicated.

## Step 5 — verify before calling it done

Open each imported draft in the real editor and confirm formatting, images
and categorisation look right — the same manual gate every other draft
already goes through, and the whole reason nothing here calls `publish`.
Spot-checking via PostgREST first is a reasonable sanity pass (`articles`
for `body_html`, `article_images` for cover/body status —
`role,status,optimized_url` should all read `ready`), but isn't a
substitute for actually looking at the rendered draft.
