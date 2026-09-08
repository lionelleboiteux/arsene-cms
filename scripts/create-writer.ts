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
import { authAdminHeaders, createOrFindAuthUser, generateSignInLink } from '../src/api/authAdmin.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
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

  const authHeaders = authAdminHeaders(serviceRoleKey);

  const writerId = await createOrFindAuthUser(supabaseUrl, authHeaders, email, displayName);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // email set here too (0007 made it not-null): re-running this script
    // for an existing writer keeps their row's email in sync with whatever
    // was just passed on the command line, same as display_name already did.
    await client.query(
      `insert into writers (id, email, display_name) values ($1, $2, $3)
         on conflict (id) do update set email = excluded.email, display_name = excluded.display_name`,
      [writerId, email, displayName],
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
