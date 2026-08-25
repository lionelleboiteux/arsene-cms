import { createArseneClient, type ArseneClient } from '../../../src/api/client.ts';
import { supabase, ARSENE_API_BASE } from './supabaseClient.ts';

/**
 * A fresh client bound to the writer's *current* access token on every call
 * — cheap (just closures), and correct across Supabase's own background
 * token refresh, which a client built once at login would miss.
 */
export async function arseneClient(): Promise<ArseneClient> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined) throw new Error('Not signed in.');
  return createArseneClient({ baseUrl: ARSENE_API_BASE, bearerToken: token });
}
