/**
 * Batch-generates a static HTML archive of every Wix blog post that was
 * never manually imported as a real Arsène article (`scripts/wix-import/`)
 * — so an old `/post/{slug}` bookmark still resolves somewhere real once
 * the Wix account closes, without adding a single row to Postgres or
 * touching Supabase Storage (that's the whole point of this script, per
 * the user's own requirement — the real articles pipeline already covers
 * the curated handful worth full editorial treatment).
 *
 * Run standalone with `node --experimental-strip-types` — NOT through the
 * agent-only Wix MCP connector, which caps responses around 50KB and needs
 * one agent tool call per fetch (fine for a couple of posts, not for
 * Wix's real 646). Needs a real Wix API key (Business Manager -> Settings
 * -> API Keys, Blog read scope) and the site ID, both as env vars; a site-
 * level API key call must carry a `wix-site-id` header alongside
 * `Authorization` (confirmed via Wix's own REST auth docs — this is not
 * the OAuth-session shape the agent connector uses).
 *
 * Writes into `../wix-archive/site/` (a sibling checkout of the
 * `wix-archive` repo) by default. Resumable, not a full wipe-and-redo each
 * run: a post whose `{slug}/index.html` already exists is skipped (a
 * 646-post run is long enough to realistically get interrupted), while a
 * post that no longer belongs — one later promoted to a real Arsène
 * article, or unpublished on Wix — has its stale directory actively
 * removed up front rather than just left orphaned.
 */
import { writeFile, mkdir, rm, copyFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { convertRicosToHtml, type RicosDecoration } from '../wix-import/convertRicos.ts';
import { resolveTaxonomy, LEAGUE_PRIORITY } from '../wix-import/categoryMap.ts';
import { page } from '../../src/site/render.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} must be set`);
  return value;
}

const WIX_API_KEY = requireEnv('WIX_API_KEY');
const WIX_SITE_ID = requireEnv('WIX_SITE_ID');
const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.resolve(import.meta.dirname, '../../../wix-archive/site');
// A dry-run cap — e.g. `ARCHIVE_LIMIT=5` to sanity-check conversion output
// before the real 646-post run (same discipline as import-wix-articles'
// own "check the batch before the real import" step).
const LIMIT = process.env.ARCHIVE_LIMIT === undefined ? undefined : Number(process.env.ARCHIVE_LIMIT);

type WixPostSummary = {
  id: string;
  slug: string;
  title: string;
  categoryIds: string[];
  firstPublishedDate: string;
  media?: { wixMedia?: { image?: { url?: string } } };
};

type RicosNodeLike = {
  type: string;
  nodes?: RicosNodeLike[];
  textData?: { text?: string; decorations?: RicosDecoration[] };
  imageData?: { image?: { src?: { id?: string } }; altText?: string };
  headingData?: { level?: number };
};

type WixPostDetail = {
  title: string;
  slug: string;
  excerpt?: string;
  firstPublishedDate: string;
  richContent: { nodes?: RicosNodeLike[] };
  media?: { wixMedia?: { image?: { url?: string } } };
};

const REQUEST_TIMEOUT_MS = 30_000;

/** Plain `fetch` has no default timeout — a single stalled connection
 *  across ~650 sequential requests hung the whole run indefinitely the
 *  first time this was tried live (8+ minutes elapsed, 13s of actual CPU
 *  time). One retry after the timeout, since a real Wix/network hiccup is
 *  more likely than a systematic failure. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt === 2) throw err;
      console.error(`  (timed out/failed, retrying once) ${url}: ${String(err)}`);
    }
  }
  throw new Error('unreachable');
}

async function wixRequest<T>(url: string, init: { method: string; body?: unknown }): Promise<T> {
  const res = await fetchWithTimeout(url, {
    method: init.method,
    headers: {
      Authorization: WIX_API_KEY,
      'wix-site-id': WIX_SITE_ID,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Wix API ${init.method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Every published post's id/slug/title, paginated — `fieldsets: ['URL']`
 *  keeps each page small, since the rich content isn't needed until each
 *  post's own individual fetch in `archivePost`. */
// A blog has a hard 100,000-post ceiling per Wix's own docs; at 100/page
// that's 1,000 pages. A cheap backstop against ever looping unbounded
// again the way the paging/cursorPaging mix-up above did live.
const MAX_PAGES = 1_000;

async function listAllPublishedPosts(): Promise<WixPostSummary[]> {
  const posts: WixPostSummary[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // `paging` and `cursorPaging` are mutually exclusive — sending both
    // makes the API silently ignore `cursorPaging` and return page 1
    // again every time, confirmed live (identical post IDs, same "next"
    // cursor, forever). Only `paging` on the very first request; only
    // `cursorPaging` on every one after.
    const query: Record<string, unknown> =
      cursor === undefined ? { paging: { limit: 100 } } : { cursorPaging: { cursor, limit: 100 } };
    const res = await wixRequest<{
      posts: WixPostSummary[];
      pagingMetadata: { cursors: { next?: string }; hasNext: boolean };
    }>('https://www.wixapis.com/blog/v3/posts/query', {
      method: 'POST',
      body: { fieldsets: ['URL'], query },
    });
    posts.push(...res.posts);
    console.log(`  ...${posts.length} posts listed so far`);
    if (!res.pagingMetadata.hasNext || res.pagingMetadata.cursors.next === undefined) break;
    cursor = res.pagingMetadata.cursors.next;
    if (LIMIT !== undefined && posts.length >= LIMIT) break;
  }
  return LIMIT === undefined ? posts : posts.slice(0, LIMIT);
}

/** Same accent-stripping `toSlug()` already does (`src/domain/seo.ts`) —
 *  needed because a Wix post's own raw `slug` can carry accents
 *  (`eliteserien-2026-bilan-à-mi-saison`) that a real Arsène article's
 *  slug never does (`toSlug()` strips them at publish time), so an exact
 *  string match misses posts that are, in fact, already real articles.
 *  Confirmed live: without this, the manually-imported Eliteserien
 *  article duplicated straight back into the archive. */
function normalizeSlug(slug: string): string {
  return slug.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Same idempotency intent as `scripts/wix-import/importPosts.ts`'s own
 *  `articles?slug=eq.{slug}` check, but matched on `normalizeSlug()`
 *  rather than an exact string — see that function's own doc comment.
 *  Fetches every published article's slug unfiltered (19 real articles as
 *  of this writing — an `in.()` chunked fetch keyed on Wix's own raw,
 *  possibly-accented slugs would just reproduce the same mismatch this
 *  function exists to avoid) rather than one Wix-slug-keyed query per
 *  chunk. A post already a real Arsène article gets `resolveWixPostPath`'s
 *  real treatment and has no business being duplicated into the archive. */
async function alreadyImportedNormalizedSlugs(): Promise<Set<string>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/articles?select=slug&status=eq.published`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`PostgREST slug fetch failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { slug: string | null }[];
  return new Set(rows.filter((row): row is { slug: string } => row.slug !== null).map((row) => normalizeSlug(row.slug)));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extensionFor(contentType: string | null): string {
  if (contentType?.includes('png') === true) return 'png';
  if (contentType?.includes('webp') === true) return 'webp';
  if (contentType?.includes('gif') === true) return 'gif';
  return 'jpg';
}

/** Downloads one Wix media image and writes it under `media/`, returning
 *  the site-relative path to reference from the archived page. Original
 *  Wix bytes, no resize/optimization — this is a one-time archive of old
 *  content, not the real image pipeline. */
async function archiveImage(wixUrl: string, outputDir: string): Promise<string> {
  const res = await fetchWithTimeout(wixUrl, {});
  if (!res.ok) throw new Error(`image fetch failed: ${wixUrl} -> ${res.status}`);
  const id = wixUrl.split('/').pop() ?? 'image';
  // Wix's own media id usually already ends in a real extension (e.g.
  // `..._mv2.webp`) — only append the content-type-derived one when it
  // doesn't, so a file doesn't end up double-extensioned (`.webp.webp`).
  const hasKnownExtension = /\.(jpe?g|png|webp|gif)$/i.test(id);
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = hasKnownExtension ? safeId : `${safeId}.${extensionFor(res.headers.get('content-type'))}`;
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(path.join(outputDir, 'media'), { recursive: true });
  await writeFile(path.join(outputDir, 'media', filename), bytes);
  return `/media/${filename}`;
}

async function archivePost(id: string, outputDir: string): Promise<void> {
  const { post } = await wixRequest<{ post: WixPostDetail }>(
    `https://www.wixapis.com/blog/v3/posts/${id}?fieldsets=RICH_CONTENT`,
    { method: 'GET' },
  );

  const { html, images } = convertRicosToHtml(post.richContent);
  let body = html;
  for (const image of images) {
    // A real, confirmed case live (44/633 posts): some Wix media — mostly
    // small club-crest icons — 403 from static.wixstatic.com no matter
    // what's sent (plain, browser User-Agent + Referer, even the exact
    // URL scraped verbatim from the live rendered page all 403 alike) —
    // genuinely access-restricted at Wix's CDN, not a request-shape fix.
    // One broken image shouldn't sink an otherwise-fine post, so it's
    // just dropped rather than failing the whole `archivePost` call.
    try {
      const localPath = await archiveImage(image.wixUrl, outputDir);
      body = body.replace(image.placeholder, `<img src="${localPath}" alt="${escapeHtml(image.altText)}"/>`);
    } catch (err) {
      console.error(`  (image unreachable, dropped) ${image.wixUrl}: ${String(err)}`);
      body = body.replace(image.placeholder, '');
    }
  }

  const coverUrl = post.media?.wixMedia?.image?.url;
  let coverPath: string | null = null;
  if (coverUrl !== undefined) {
    try {
      coverPath = await archiveImage(coverUrl, outputDir);
    } catch (err) {
      console.error(`  (cover image unreachable, falling back to title-only) ${coverUrl}: ${String(err)}`);
    }
  }
  const hero =
    coverPath === null
      ? `<h1 class="title-only">${escapeHtml(post.title)}</h1>`
      : `<figure class="hero"><img src="${coverPath}" alt=""/><div class="scrim"></div><h1>${escapeHtml(post.title)}</h1></figure>`;

  const publishedDate = new Date(post.firstPublishedDate).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  // No writer avatar/byline system here — archive posts have no Arsène
  // writer row, and resolving a Wix member ID to a friendly name isn't
  // worth a second API call per post for old, uncurated content.
  const meta = `<p class="meta"><span class="author">Fantasy Coach — archive Wix</span><span class="sep">·</span>Publié le ${publishedDate}</p>`;
  const pageBody = `<main data-article-title="${escapeHtml(post.title)}">${hero}${meta}<div class="body">${body}</div></main>`;

  const head =
    post.excerpt === undefined || post.excerpt === ''
      ? '<meta name="robots" content="index, follow"/>'
      : `<meta name="description" content="${escapeHtml(post.excerpt)}"/><meta name="robots" content="index, follow"/>`;

  // forceLight=false, showFcNav=true — same as `renderArticlePage`'s own
  // real articles: follows the visitor's device preference, and gets the
  // real shared nav so an archive page doesn't look foreign.
  const rendered = page(post.title, head, pageBody, undefined, false, true);

  const dir = path.join(outputDir, post.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), rendered);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Finds a post's already-downloaded cover file on disk by matching
 *  `archiveImage`'s own naming rule in reverse, rather than re-fetching
 *  anything — the index is built from the lightweight listing data
 *  (`WixPostSummary`), which only has the *original* Wix media URL, not
 *  the local path a given cover ended up at (or whether it failed and
 *  has no local file at all, per the 403s some images hit live). */
function findLocalCover(coverUrl: string | undefined, mediaFiles: Set<string>): string | null {
  if (coverUrl === undefined) return null;
  const id = coverUrl.split('/').pop() ?? '';
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (mediaFiles.has(safeId)) return `/media/${safeId}`;
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const candidate = `${safeId}.${ext}`;
    if (mediaFiles.has(candidate)) return `/media/${candidate}`;
  }
  return null;
}

const nameCollator = new Intl.Collator('fr');
const UNKNOWN_LEAGUE = 'Autres';
const UNKNOWN_TYPE = 'Non classé';
/** Distinct league names in the same priority order `categoryMap.ts` itself
 *  uses to break ties on a single post — reused here purely for display
 *  order, matching the real site's own league-pill order (Ligue 1, Premier
 *  League, Bundesliga first) rather than an arbitrary alphabetical one. */
const LEAGUE_ORDER = [...new Set(LEAGUE_PRIORITY.map((entry) => entry.value))];

function compareLeagues(a: string, b: string): number {
  if (a === UNKNOWN_LEAGUE || b === UNKNOWN_LEAGUE) return a === b ? 0 : a === UNKNOWN_LEAGUE ? 1 : -1;
  const ai = LEAGUE_ORDER.indexOf(a);
  const bi = LEAGUE_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return nameCollator.compare(a, b);
}

function compareTypes(a: string, b: string): number {
  if (a === UNKNOWN_TYPE || b === UNKNOWN_TYPE) return a === b ? 0 : a === UNKNOWN_TYPE ? 1 : -1;
  return nameCollator.compare(a, b);
}

/** One archive card — same `.article-card`/`.articles` classes real
 *  listing pages use (`articleCard()`, `src/site/render.ts`), reused
 *  as-is via `page()`'s inlined `SITE_CSS` rather than duplicated, so an
 *  archive index page reads as visually native to the rest of the site.
 *  No author byline (archive posts have no Arsène writer row) — just the
 *  publish date, in the same spot `archivePost`'s own meta line uses. */
function archiveCard(post: WixPostSummary, coverUrl: string, mediaFiles: Set<string>): string {
  const localCover = findLocalCover(coverUrl, mediaFiles);
  const cover =
    localCover === null ? '' : `<img src="${localCover}" alt="${escapeHtml(post.title)}" class="article-card-cover"/>`;
  const publishedDate = new Date(post.firstPublishedDate).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return [
    `<li class="article-card" data-article-title="${escapeHtml(post.title)}">`,
    `<a href="/${post.slug}/">`,
    '<div class="article-card-text">',
    `<h3 class="article-card-title">${escapeHtml(post.title)}</h3>`,
    `<p class="article-card-byline">Publié le ${publishedDate}</p>`,
    '</div>',
    '<p class="article-card-teaser"></p>',
    cover,
    '</a>',
    '</li>',
  ].join('');
}

const ARCHIVE_INDEX_CSS = `
.archive-h1{max-width:900px;margin:1.5rem auto .25rem;padding:0 1rem;font-size:1.5rem}
h3.archive-type-title{max-width:900px;margin:.75rem auto .25rem;padding:0 1rem;font-size:1rem;color:var(--muted);font-weight:700}
`;

/** Grouped by league then type, mirroring `leagueListing()`'s own real-site
 *  convention exactly (`src/site/render.ts`): a league section only gets
 *  per-type subheadings once it actually has more than one distinct type
 *  among its archived posts, otherwise a flat card list. */
async function buildIndex(posts: WixPostSummary[], outputDir: string): Promise<void> {
  const mediaDir = path.join(outputDir, 'media');
  const mediaFiles = new Set(await exists(mediaDir) ? await readdir(mediaDir) : []);

  const byLeague = new Map<string, Map<string, WixPostSummary[]>>();
  for (const post of posts) {
    const { league_name, type_name } = resolveTaxonomy(post.categoryIds ?? []);
    const league = league_name ?? UNKNOWN_LEAGUE;
    const type = type_name ?? UNKNOWN_TYPE;
    if (!byLeague.has(league)) byLeague.set(league, new Map());
    const byType = byLeague.get(league) as Map<string, WixPostSummary[]>;
    if (!byType.has(type)) byType.set(type, []);
    (byType.get(type) as WixPostSummary[]).push(post);
  }

  const byDateDesc = (a: WixPostSummary, b: WixPostSummary): number =>
    b.firstPublishedDate.localeCompare(a.firstPublishedDate);

  const leagues = [...byLeague.keys()].sort(compareLeagues);
  const sections = leagues.map((league) => {
    const byType = byLeague.get(league) as Map<string, WixPostSummary[]>;
    const types = [...byType.keys()].sort(compareTypes);
    const cardsFor = (list: WixPostSummary[]): string =>
      `<ul class="articles">${[...list]
        .sort(byDateDesc)
        .map((post) => archiveCard(post, post.media?.wixMedia?.image?.url ?? '', mediaFiles))
        .join('')}</ul>`;
    const body =
      types.length <= 1
        ? cardsFor(byType.get(types[0] ?? UNKNOWN_TYPE) ?? [])
        : types
            .map(
              (type) =>
                `<h3 class="archive-type-title">${escapeHtml(type)}</h3>${cardsFor(byType.get(type) ?? [])}`,
            )
            .join('');
    return `<h2 class="section-title">${escapeHtml(league)}</h2>${body}`;
  });

  const intro = `<p class="listing-intro">${posts.length} ancien${posts.length === 1 ? '' : 's'} article${posts.length === 1 ? '' : 's'} Wix, non repris individuellement sur Arsène.</p>`;
  const body = `<h1 class="archive-h1">Archives</h1>${intro}${sections.join('')}`;
  const head = [
    `<style>${ARCHIVE_INDEX_CSS}</style>`,
    `<meta name="description" content="Archives des anciens articles Wix de Fantasy Coach, classées par ligue et par catégorie."/>`,
    '<meta name="robots" content="index, follow"/>',
  ].join('');

  const rendered = page('Archives — Fantasy Coach', head, body, undefined, true, true);
  await writeFile(path.join(outputDir, 'index.html'), rendered);
}

async function main(): Promise<void> {
  console.log('Fetching post list from Wix...');
  const posts = await listAllPublishedPosts();
  console.log(`${posts.length} published posts found.`);

  const alreadyImported = await alreadyImportedNormalizedSlugs();
  const toArchive = posts.filter((p) => !alreadyImported.has(normalizeSlug(p.slug)));
  console.log(
    `${posts.length - toArchive.length} already real Arsène articles, skipped. ${toArchive.length} to archive.`,
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, 'CNAME'), 'archive.fantasy-coach.fr\n');
  // `page()` references `/assets/favicon.png` as an absolute path — real
  // on cms.fantasy-coach.fr, not on this separate archive.fantasy-coach.fr
  // origin unless copied in too.
  await mkdir(path.join(OUTPUT_DIR, 'assets'), { recursive: true });
  await copyFile(
    path.resolve(import.meta.dirname, '../../public-site/public/assets/favicon.png'),
    path.join(OUTPUT_DIR, 'assets', 'favicon.png'),
  );

  // A stale page — a post later promoted to a real Arsène article (and so
  // now excluded from `toArchive`), or one no longer published on Wix at
  // all — gets removed here, up front, rather than via a blanket wipe of
  // the whole output dir: a 646-post run is long enough to realistically
  // get interrupted, and resuming should skip work already done below,
  // not redo it.
  //
  // Skipped entirely when `LIMIT` is set: a `toArchive` truncated to a
  // handful of posts for a dry run is not a legitimate "everything else
  // is stale" signal — confirmed live, an `ARCHIVE_LIMIT=30` sanity check
  // deleted ~600 already-archived posts' directories the first time this
  // ran without the guard, because none of them were in that run's own
  // artificially small `toArchive` set.
  if (LIMIT === undefined) {
    const toArchiveSlugs = new Set(toArchive.map((p) => p.slug));
    const existingDirs = await readdir(OUTPUT_DIR, { withFileTypes: true });
    for (const entry of existingDirs) {
      if (entry.isDirectory() && entry.name !== 'media' && entry.name !== 'assets' && !toArchiveSlugs.has(entry.name)) {
        await rm(path.join(OUTPUT_DIR, entry.name), { recursive: true, force: true });
      }
    }
  }

  let done = 0;
  let skipped = 0;
  // Every post that actually has a page on disk by the end — freshly
  // archived this run or already present from an earlier one — goes into
  // the index; a post whose `archivePost` call outright failed (the post
  // fetch itself, not just one dropped image) has no page and is excluded.
  const succeeded: WixPostSummary[] = [];
  for (const p of toArchive) {
    if (await exists(path.join(OUTPUT_DIR, p.slug, 'index.html'))) {
      skipped += 1;
      succeeded.push(p);
      continue;
    }
    try {
      await archivePost(p.id, OUTPUT_DIR);
    } catch (err) {
      console.error(`FAILED: ${p.slug} (${p.id}):`, err);
      continue;
    }
    succeeded.push(p);
    done += 1;
    if (done % 10 === 0) console.log(`${done}/${toArchive.length} archived...`);
  }
  console.log(`Done. ${done} newly archived, ${skipped} already present (resumed), into ${OUTPUT_DIR}.`);

  await buildIndex(succeeded, OUTPUT_DIR);
  console.log(`Index written for ${succeeded.length} posts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
