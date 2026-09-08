import { createClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = import.meta.env[name] as string | undefined;
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set — see frontend/.env.example`);
  }
  return value;
}

/**
 * Default options (`detectSessionInUrl: true`, PKCE flow) handle the
 * magic-link redirect automatically on load — no dedicated callback route.
 * The session lives in `localStorage`, so a reload keeps the writer signed in.
 */
export const supabase = createClient(
  requireEnv('VITE_SUPABASE_URL'),
  requireEnv('VITE_SUPABASE_ANON_KEY'),
);

export const ARSENE_API_BASE = requireEnv('VITE_ARSENE_API_BASE');

/** The one origin an inline `<img src>` in the body editor is ever allowed
 *  to point at (`sanitizePastedHtml`, `src/domain/paste.ts`) — same value
 *  `router.ts` already resolves server-side from `CDN_ORIGIN`. */
export const CDN_ORIGIN = requireEnv('VITE_CDN_ORIGIN');
