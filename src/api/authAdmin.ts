/**
 * Supabase Auth Admin REST API calls shared between `scripts/create-writer.ts`
 * (the original, operator-run provisioning path) and `adminWriters.ts` (the
 * settings page's `/v1/admin/writers` route, added later) — lifted out of
 * the script verbatim rather than duplicated, so there is exactly one place
 * that knows how a writer's Supabase Auth user gets created or found.
 *
 * `authHeaders` is passed in rather than read from `process.env`/`Deno.env`
 * here, so this module has no opinion about which runtime it's called from
 * — both the Node CLI script and the Deno Edge Function already build these
 * headers their own way, exactly as before this file existed.
 */

export type AuthUser = { id: string; email?: string };

export function authAdminHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

export async function createOrFindAuthUser(
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

export async function generateSignInLink(
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

/**
 * A real, short-lived Supabase Auth access token for `email` — the writer-
 * facing API (`router.ts`'s `verify()`) only accepts a genuine Supabase-
 * issued JWT (`role: authenticated`, `sub` = the writer's id), so a script
 * driving `ArseneClient` needs one of these rather than the service-role
 * key itself (which carries `role: service_role` and is refused the same
 * way `NFR-JWT-10` already refuses an `anon`-role token in its place).
 *
 * Headless equivalent of clicking a magic link: `generate_link` mints one
 * without sending any email, then `/auth/v1/verify` redeems it — Supabase
 * responds to that redemption with a redirect carrying the session in the
 * `Location` header's URL fragment (`#access_token=...`), which a fragment
 * being client-side-only doesn't stop a plain `fetch` from reading, since
 * the fragment is just text in a header value here, never sent to a
 * browser to execute.
 */
export async function mintAccessToken(
  supabaseUrl: string,
  authHeaders: Record<string, string>,
  email: string,
): Promise<string> {
  const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!linkRes.ok) {
    throw new Error(`failed to generate a sign-in link for ${email} (${linkRes.status}): ${await linkRes.text()}`);
  }
  const { hashed_token } = (await linkRes.json()) as { hashed_token?: string };
  if (hashed_token === undefined) {
    throw new Error(`generate_link response for ${email} carried no hashed_token`);
  }

  const verifyRes = await fetch(
    `${supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(hashed_token)}&type=magiclink&redirect_to=${encodeURIComponent(supabaseUrl)}`,
    { redirect: 'manual', headers: authHeaders },
  );
  const location = verifyRes.headers.get('location');
  if (location === null) {
    throw new Error(`redeeming the sign-in link for ${email} did not redirect (status ${verifyRes.status})`);
  }
  const accessToken = new URLSearchParams(new URL(location).hash.slice(1)).get('access_token');
  if (accessToken === null) {
    throw new Error(`redeeming the sign-in link for ${email} redirected with no access_token in the fragment`);
  }
  return accessToken;
}
