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
 * `wix-archive` repo) by default, fully replacing it each run — so a post
 * later promoted to a real Arsène article (and thus now skipped by the
 * idempotency check below) actually loses its stale archive page too, not
 * just gets orphaned by it.
 */
import { writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { convertRicosToHtml, type RicosDecoration } from '../wix-import/convertRicos.ts';
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

type WixPostSummary = { id: string; slug: string; title: string };

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

async function wixRequest<T>(url: string, init: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
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
async function listAllPublishedPosts(): Promise<WixPostSummary[]> {
  const posts: WixPostSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query: Record<string, unknown> = { paging: { limit: 100 } };
    if (cursor !== undefined) query.cursorPaging = { cursor, limit: 100 };
    const res = await wixRequest<{
      posts: WixPostSummary[];
      pagingMetadata: { cursors: { next?: string }; hasNext: boolean };
    }>('https://www.wixapis.com/blog/v3/posts/query', {
      method: 'POST',
      body: { fieldsets: ['URL'], query },
    });
    posts.push(...res.posts);
    if (!res.pagingMetadata.hasNext || res.pagingMetadata.cursors.next === undefined) break;
    cursor = res.pagingMetadata.cursors.next;
    if (LIMIT !== undefined && posts.length >= LIMIT) break;
  }
  return LIMIT === undefined ? posts : posts.slice(0, LIMIT);
}

/** Same idempotency shape as `scripts/wix-import/importPosts.ts`
 *  (`articles?slug=eq.{slug}`, just batched here since there are hundreds
 *  of slugs to check, not one) — a post already a real Arsène article
 *  gets `resolveWixPostPath`'s real treatment and has no business being
 *  duplicated into the archive. */
async function alreadyImportedSlugs(slugs: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const CHUNK = 50;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK);
    const url = `${SUPABASE_URL}/rest/v1/articles?select=slug&slug=in.(${chunk.map(encodeURIComponent).join(',')})`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`PostgREST slug check failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as { slug: string }[];
    for (const row of rows) found.add(row.slug);
  }
  return found;
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
  const res = await fetch(wixUrl);
  if (!res.ok) throw new Error(`image fetch failed: ${wixUrl} -> ${res.status}`);
  const id = wixUrl.split('/').pop() ?? 'image';
  const ext = extensionFor(res.headers.get('content-type'));
  const filename = `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
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
    const localPath = await archiveImage(image.wixUrl, outputDir);
    body = body.replace(image.placeholder, `<img src="${localPath}" alt="${escapeHtml(image.altText)}"/>`);
  }

  const coverUrl = post.media?.wixMedia?.image?.url;
  const hero =
    coverUrl === undefined
      ? `<h1 class="title-only">${escapeHtml(post.title)}</h1>`
      : `<figure class="hero"><img src="${await archiveImage(coverUrl, outputDir)}" alt=""/><div class="scrim"></div><h1>${escapeHtml(post.title)}</h1></figure>`;

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

async function main(): Promise<void> {
  console.log('Fetching post list from Wix...');
  const posts = await listAllPublishedPosts();
  console.log(`${posts.length} published posts found.`);

  const alreadyImported = await alreadyImportedSlugs(posts.map((p) => p.slug));
  const toArchive = posts.filter((p) => !alreadyImported.has(p.slug));
  console.log(`${alreadyImported.size} already real Arsène articles, skipped. ${toArchive.length} to archive.`);

  // Full replace, not incremental additions — see the module doc comment.
  await rm(OUTPUT_DIR, { recursive: true, force: true });
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

  let done = 0;
  for (const p of toArchive) {
    try {
      await archivePost(p.id, OUTPUT_DIR);
    } catch (err) {
      console.error(`FAILED: ${p.slug} (${p.id}):`, err);
      continue;
    }
    done += 1;
    if (done % 25 === 0) console.log(`${done}/${toArchive.length} archived...`);
  }
  console.log(`Done. ${done}/${toArchive.length} archived into ${OUTPUT_DIR}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
