#!/usr/bin/env -S node --experimental-strip-types
/**
 * Arsène — import a batch of Wix blog posts as drafts.
 *
 * Takes a JSON file of raw Wix post objects (exactly what `GET /v3/posts` or
 * `POST /v3/posts/query` returns with `fieldsets=RICH_CONTENT` — the Wix MCP
 * connector's `CallWixSiteAPI` is how those get fetched and saved to a file
 * in the first place; see `.claude/skills/import-wix-articles/SKILL.md` for
 * the full repeatable procedure, including how to pull that batch).
 *
 * Drives Arsène through its own real writer-facing surface, the same paths
 * a writer's browser takes, not a shortcut around them:
 *   - `ArseneClient` (`src/api/client.ts`) for createDraft/uploadArticleImage
 *     — the actual Edge Function routes, S3/Lambda pipeline included.
 *   - Direct PostgREST calls for taxonomy resolve and saving fields — the
 *     same calls `useTaxonomy.ts`/`useDraft.ts` make from the browser, just
 *     issued from Node instead, under a real writer session (RLS applies).
 *
 * Every import lands as a draft. Nothing here ever calls publish — a human
 * reviews formatting, categorisation and images before making anything
 * live, the same bar every other draft already clears.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   ARSENE_API_BASE=... ADMIN_EMAIL=racc.leraccoon@gmail.com \
 *     node --experimental-strip-types scripts/wix-import/importPosts.ts <path-to-posts.json>
 */

import { createArseneClient } from '../../src/api/client.ts';
import { authAdminHeaders, mintAccessToken } from '../../src/api/authAdmin.ts';
import { convertRicosToHtml } from './convertRicos.ts';
import { resolveTaxonomy } from './categoryMap.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} must be set`);
  return value;
}

type WixPost = {
  id: string;
  title: string;
  slug: string;
  categoryIds: string[];
  richContent?: { nodes?: unknown[] };
  media?: { wixMedia?: { image?: { url?: string; altText?: string; filename?: string } } };
};

async function postgrest(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown; extraHeaders?: Record<string, string> } = {},
): Promise<unknown> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...init.extraHeaders,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`PostgREST ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Mirrors `useTaxonomy.ts`'s `resolve()` — reuse an existing row, create
 *  the one that's missing. Taxonomy creation is open, on demand (AC-10). */
async function resolveOrCreate(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  table: 'arsene_leagues' | 'categories',
  match: Record<string, string>,
): Promise<string> {
  const filters = Object.entries(match)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const existing = (await postgrest(supabaseUrl, anonKey, accessToken, `${table}?select=id&${filters}`)) as {
    id: string;
  }[];
  if (existing[0] !== undefined) return existing[0].id;

  const created = (await postgrest(supabaseUrl, anonKey, accessToken, table, {
    method: 'POST',
    body: match,
    extraHeaders: { Prefer: 'return=representation' },
  })) as { id: string }[];
  const row = created[0];
  if (row === undefined) throw new Error(`insert into ${table} returned no row`);
  return row.id;
}

async function downloadImage(url: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const filename = decodeURIComponent(url.split('/').pop() ?? 'image');
  return { bytes, contentType, filename };
}

/** Polls `article_images` the same way `useImageSlot.ts` does, until the
 *  Lambda conversion callback flips the row out of `processing`. */
async function waitForReady(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  imageId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const rows = (await postgrest(
      supabaseUrl,
      anonKey,
      accessToken,
      `article_images?id=eq.${imageId}&select=status,optimized_url,failure_message`,
    )) as { status: string; optimized_url: string | null; failure_message: string | null }[];
    const row = rows[0];
    if (row === undefined) throw new Error(`article_images row ${imageId} vanished while polling`);
    if (row.status === 'ready' && row.optimized_url !== null) return row.optimized_url;
    if (row.status === 'failed') throw new Error(`image ${imageId} failed to convert: ${row.failure_message ?? 'unknown reason'}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`image ${imageId} never left "processing" after 60s`);
}

async function importOne(
  post: WixPost,
  deps: {
    supabaseUrl: string;
    anonKey: string;
    accessToken: string;
    client: ReturnType<typeof createArseneClient>;
  },
): Promise<{ status: 'imported'; articleId: string } | { status: 'skipped'; reason: string }> {
  const existing = (await postgrest(
    deps.supabaseUrl,
    deps.anonKey,
    deps.accessToken,
    `articles?slug=eq.${encodeURIComponent(post.slug)}&select=id`,
  )) as { id: string }[];
  if (existing[0] !== undefined) {
    return { status: 'skipped', reason: `an article with slug "${post.slug}" already exists (id ${existing[0].id})` };
  }

  const { league_name, type_name } = resolveTaxonomy(post.categoryIds);
  if (league_name === null || type_name === null) {
    return {
      status: 'skipped',
      reason: `categories ${JSON.stringify(post.categoryIds)} didn't resolve to a league+type (league=${league_name}, type=${type_name}) — add a mapping in categoryMap.ts or categorise it by hand after a manual import`,
    };
  }

  const { html, images } = convertRicosToHtml(post.richContent ?? {});

  const created = (await deps.client.createDraft({ title: post.title })) as { article_id: string };
  const articleId = created.article_id;

  // Sequential, not Promise.all: categories are scoped to a league, and
  // resolving the same league twice concurrently would race two "does it
  // exist yet" checks against each other, risking two duplicate league rows.
  const league_id = await resolveOrCreate(deps.supabaseUrl, deps.anonKey, deps.accessToken, 'arsene_leagues', {
    name: league_name,
  });
  const category_id = await resolveOrCreate(deps.supabaseUrl, deps.anonKey, deps.accessToken, 'categories', {
    name: type_name,
    league_id,
  });

  const coverUrl = post.media?.wixMedia?.image?.url;
  if (coverUrl !== undefined) {
    const { bytes, contentType, filename } = await downloadImage(coverUrl);
    const uploaded = (await deps.client.uploadArticleImage({
      articleId,
      idempotencyKey: crypto.randomUUID(),
      role: 'cover',
      file: { filename, content_type: contentType, bytes },
    })) as { id: string };
    await waitForReady(deps.supabaseUrl, deps.anonKey, deps.accessToken, uploaded.id);
  }

  let body_html = html;
  for (const image of images) {
    const { bytes, contentType, filename } = await downloadImage(image.wixUrl);
    const uploaded = (await deps.client.uploadArticleImage({
      articleId,
      idempotencyKey: crypto.randomUUID(),
      role: 'body',
      file: { filename, content_type: contentType, bytes },
    })) as { id: string };
    const optimizedUrl = await waitForReady(deps.supabaseUrl, deps.anonKey, deps.accessToken, uploaded.id);
    const altAttr = image.altText.replace(/"/g, '&quot;');
    body_html = body_html.replace(image.placeholder, `<img src="${optimizedUrl}" alt="${altAttr}">`);
  }

  await postgrest(deps.supabaseUrl, deps.anonKey, deps.accessToken, `articles?id=eq.${articleId}`, {
    method: 'PATCH',
    body: { title: post.title, body_html, league_id, category_id, updated_at: new Date().toISOString() },
    extraHeaders: { Prefer: 'return=minimal' },
  });

  return { status: 'imported', articleId };
}

async function main() {
  const inputPath = process.argv[2];
  if (inputPath === undefined) {
    console.error('Usage: importPosts.ts <path-to-posts.json>');
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const arseneApiBase = requireEnv('ARSENE_API_BASE');
  const adminEmail = requireEnv('ADMIN_EMAIL');

  const { readFile } = await import('node:fs/promises');
  const posts = JSON.parse(await readFile(inputPath, 'utf8')) as WixPost[];

  const accessToken = await mintAccessToken(supabaseUrl, authAdminHeaders(serviceRoleKey), adminEmail);
  const client = createArseneClient({ baseUrl: arseneApiBase, bearerToken: accessToken });

  const results: { post: WixPost; outcome: Awaited<ReturnType<typeof importOne>> }[] = [];
  for (const post of posts) {
    console.log(`importing: ${post.title} (${post.slug})`);
    try {
      const outcome = await importOne(post, { supabaseUrl, anonKey, accessToken, client });
      results.push({ post, outcome });
      console.log(`  -> ${outcome.status}${outcome.status === 'skipped' ? `: ${outcome.reason}` : ` as ${outcome.articleId}`}`);
    } catch (err) {
      results.push({ post, outcome: { status: 'skipped', reason: err instanceof Error ? err.message : String(err) } });
      console.log(`  -> failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const imported = results.filter((r) => r.outcome.status === 'imported');
  const skipped = results.filter((r) => r.outcome.status === 'skipped');
  console.log(`\n${imported.length} imported, ${skipped.length} skipped, out of ${results.length} total.`);
  if (skipped.length > 0) {
    console.log('\nSkipped:');
    for (const r of skipped) {
      if (r.outcome.status === 'skipped') console.log(`  - ${r.post.title}: ${r.outcome.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
