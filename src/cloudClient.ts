// Heuresis MCP — Supabase client wrapper.
//
// One SupabaseClient per MCP process. We DON'T let supabase-js persist the
// session to localStorage (no such thing in Node) — instead we manage the
// session manually:
//
//   1. At process start: read ~/.heuresis/credentials.json → exchange the
//      refresh token for a fresh session by hitting the GoTrue token endpoint
//      directly (see gotrue.ts), then hand the resulting access_token +
//      refresh_token to `client.auth.setSession(...)`. We deliberately do NOT
//      use the old `setSession({ access_token: '', refresh_token })` trick:
//      auth-js 2.x rejects an empty access_token with "Auth session missing!"
//      before it ever refreshes. With a real access_token the guard passes
//      and supabase-js stores both tokens in memory.
//   2. supabase-js handles silent re-refresh in the background while the
//      process runs. We don't have to do anything per-tool-call.
//   3. If the refresh fails (revoked, expired), the bootstrap throws — the
//      wrapper surfaces a "re-run login" message.

// Polyfill global WebSocket on Node < 22 before any Supabase client is built.
import './wsPolyfill.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { HeuresisCredentials } from './credentials.js';
import { exchangeRefreshToken } from './gotrue.js';

let cached: { client: SupabaseClient; userId: string } | null = null;

export class CloudAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CloudAuthError';
  }
}

/**
 * Build (or return cached) a Supabase client bound to the credentials on
 * disk. Throws CloudAuthError if no credentials exist or if the refresh
 * token has been revoked.
 */
export async function getCloudClient(
  creds: HeuresisCredentials,
): Promise<{ client: SupabaseClient; userId: string }> {
  if (cached) return cached;
  const client = createClient(creds.supabase_url, creds.anon_key, {
    auth: {
      // Headless: no localStorage, no URL detection, no auto-refresh
      // listeners writing to disk. The library still auto-refreshes the
      // in-memory access token from the refresh token, which is all we want.
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  // Bootstrap the session: exchange the stored refresh token for a fresh
  // session directly against GoTrue, then seed supabase-js with the REAL
  // tokens so every subsequent PostgREST call carries the user's JWT and
  // auto-refresh keeps it alive.
  try {
    const session = await exchangeRefreshToken(
      creds.supabase_url,
      creds.anon_key,
      creds.refresh_token,
    );
    const { error } = await client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error) {
      throw new CloudAuthError(
        `Failed to seed Heuresis session: ${error.message}. ` +
          'Run `npx -y -p @heuresis/mcp heuresis-mcp login` to re-authenticate.',
      );
    }
  } catch (err) {
    if (err instanceof CloudAuthError) throw err;
    throw new CloudAuthError(
      `Failed to refresh Heuresis session: ${
        err instanceof Error ? err.message : String(err)
      }. Run \`npx -y -p @heuresis/mcp heuresis-mcp login\` to re-authenticate.`,
    );
  }
  cached = { client, userId: creds.user_id };
  return cached;
}

/** Clear the cached client. Used after logout. */
export function resetCloudClient(): void {
  cached = null;
}

/**
 * Convenience wrapper that surfaces Postgres / auth errors as a readable
 * MCP tool error. supabase-js returns `{ data, error }` everywhere; this
 * unwraps it.
 */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null) throw new Error('Empty result from cloud.');
  return res.data;
}
