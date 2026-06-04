// Heuresis MCP — direct GoTrue refresh-token exchange.
//
// Why not `supabase-js` setSession/refreshSession?
// ------------------------------------------------
// We run headless in Node — there is no localStorage and no persisted
// session for supabase-js to read. The previous code tried to bootstrap a
// session with `client.auth.setSession({ access_token: '', refresh_token })`,
// relying on the old behavior where an empty access_token forced an immediate
// refresh from the refresh token. That trick is dead as of @supabase/auth-js
// 2.x: `_setSession` now guards at the very top —
//
//     if (!currentSession.access_token || !currentSession.refresh_token) {
//       throw new AuthSessionMissingError();   // → "Auth session missing!"
//     }
//
// so an empty `access_token` throws `AuthSessionMissingError` ("Auth session
// missing!") BEFORE it ever attempts the refresh. `refreshSession()` has the
// same problem in a different shape — it leans on a stored session that does
// not exist here.
//
// The robust path is to hit the GoTrue token endpoint directly. It exchanges
// a bare refresh token for a fresh session with zero stored-state
// assumptions, and it is exactly what supabase-js does internally once it has
// a session — including refresh-token rotation.

/** The session payload GoTrue returns from `/token?grant_type=refresh_token`. */
export interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user?: { id?: string; email?: string | null; [k: string]: unknown } | null;
}

export class RefreshTokenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RefreshTokenError';
  }
}

/**
 * Exchange a refresh token for a fresh session via the GoTrue token endpoint:
 *
 *   POST `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`
 *   headers: { apikey, Authorization: Bearer <anon>, Content-Type: application/json }
 *   body:    { refresh_token }
 *
 * Returns the full session (access_token + the rotated refresh_token + the
 * user). Throws `RefreshTokenError` with an actionable message — including the
 * response's keys when the expected token fields are missing — on any failure.
 */
export async function exchangeRefreshToken(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<GoTrueSession> {
  if (!refreshToken) {
    throw new RefreshTokenError(
      'No refresh token to exchange (the value was empty/undefined). ' +
        'The pairing response did not carry a usable token.',
    );
  }
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    throw new RefreshTokenError(
      `Could not reach the auth endpoint at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* leave null — handled below */
  }

  if (!res.ok) {
    const err = payload as
      | { error_description?: string; error?: string; msg?: string; message?: string }
      | null;
    const detail =
      err?.error_description ?? err?.msg ?? err?.error ?? err?.message ?? `HTTP ${res.status}`;
    throw new RefreshTokenError(`Token refresh failed (HTTP ${res.status}): ${detail}`);
  }

  const session = payload as GoTrueSession | null;
  if (!session || !session.access_token || !session.refresh_token) {
    const keys =
      session && typeof session === 'object'
        ? Object.keys(session).join(', ') || '(empty object)'
        : '(no JSON body)';
    throw new RefreshTokenError(
      `Token refresh succeeded (HTTP ${res.status}) but the response is missing ` +
        `access_token/refresh_token. Response keys: [${keys}].`,
    );
  }
  return session;
}
