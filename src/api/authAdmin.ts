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
