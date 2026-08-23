#!/usr/bin/env -S node --experimental-strip-types
/**
 * Arsène — provision a writer.
 *
 * There is no signup flow: writers are Supabase Auth users, and `auth.ts`'s
 * JWT `sub` claim *is* `writers.id` (02-architecture.v1.md §7/§10). This
 * script is the missing other half — it creates the Supabase Auth user (or
 * finds the one already registered under the given email, so re-running is
 * safe) via the Auth Admin REST API, then upserts the matching `writers` row
 * with that same id, and finally mints a one-time sign-in link so the
 * operator can hand it to the writer without depending on project SMTP being
 * configured.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   DATABASE_URL=postgresql://... \
 *     node --experimental-strip-types scripts/create-writer.ts <email> <display name>
 */

import pg from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

type AuthUser = { id: string; email?: string };

async function createOrFindAuthUser(
  supabaseUrl: string,
  authHeaders: Record<string, string>,
  email: string,
  displayName: string,
): Promise<string> {
  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { display_name: displayName } }),
  });

  if (createRes.ok) {
    const body = (await createRes.json()) as AuthUser;
    return body.id;
  }

  // Not the happy path — only worth inspecting further if it's specifically
  // "this email is already registered", the one case we recover from.
  const errorBody = await createRes.text();
  if (!/already.*registered|email_exists/i.test(errorBody)) {
    throw new Error(`failed to create auth user (${createRes.status}): ${errorBody}`);
  }

  for (let page = 1; page <= 50; page++) {
    const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: authHeaders,
    });
    if (!listRes.ok) {
      throw new Error(
        `failed to list users while resolving existing account (${listRes.status}): ${await listRes.text()}`,
      );
    }
    const { users } = (await listRes.json()) as { users: AuthUser[] };
    if (users.length === 0) break;
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
  }

  throw new Error(`auth said "${email}" is already registered but it could not be found in the admin user list`);
}

async function generateSignInLink(
  supabaseUrl: string,
  authHeaders: Record<string, string>,
  email: string,
): Promise<string | null> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { action_link?: string };
  return body.action_link ?? null;
}

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  const displayName = nameParts.join(' ');
  if (!email || !displayName) {
    console.error('Usage: create-writer.ts <email> <display name>');
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const databaseUrl = requireEnv('DATABASE_URL');

  const authHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const writerId = await createOrFindAuthUser(supabaseUrl, authHeaders, email, displayName);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `insert into writers (id, display_name) values ($1, $2)
         on conflict (id) do update set display_name = excluded.display_name`,
      [writerId, displayName],
    );
  } finally {
    await client.end();
  }

  console.log(`writer ready: id=${writerId} email=${email} display_name=${JSON.stringify(displayName)}`);

  const link = await generateSignInLink(supabaseUrl, authHeaders, email);
  if (link) {
    console.log(`one-time sign-in link: ${link}`);
  } else {
    console.log(
      'could not generate a sign-in link (check SMTP/site-url config) — ' +
        'issue one from the Supabase dashboard (Authentication > Users) instead.',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
