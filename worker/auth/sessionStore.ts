/**
 * Server-side bearer sessions for verified platform identities.
 * The raw token is returned once; only its SHA-256 digest is stored in D1.
 */
export const DEFAULT_PLAYER_SESSION_TTL_MS = 30 * 60 * 1000;
const MIN_SESSION_TTL_MS = 60 * 1000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export type SessionStatement = {
  bind(...values: unknown[]): SessionStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
export type SessionDatabase = { prepare(query: string): SessionStatement };
export type PlayerSession = { playerId: string; expiresAtMs: number };
export type IssuedPlayerSession = PlayerSession & { token: string };

function validClock(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function tokenFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function isSessionToken(token: string): boolean { return TOKEN_PATTERN.test(token); }
export async function digestToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function issuePlayerSession(
  db: SessionDatabase, playerId: string, nowMs = Date.now(), ttlMs = DEFAULT_PLAYER_SESSION_TTL_MS,
): Promise<IssuedPlayerSession> {
  if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > 128) {
    throw new TypeError('A valid player ID is required.');
  }
  if (!validClock(nowMs)) throw new TypeError('Session creation time must be a non-negative safe integer.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_SESSION_TTL_MS || ttlMs > MAX_SESSION_TTL_MS) {
    throw new RangeError('Session lifetime must be between one minute and 24 hours.');
  }
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new RangeError('Session expiry is outside the supported clock range.');
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const token = tokenFromBytes(random);
  const tokenHash = await digestToken(token);
  // Prune only this player's expired/revoked sessions during login. The player/expiry index
  // keeps the cleanup scoped; active sessions belonging to other players are untouched.
  await db.prepare(`DELETE FROM player_sessions
    WHERE player_id = ? AND (expires_at_ms <= ? OR revoked_at_ms IS NOT NULL)`)
    .bind(playerId, nowMs).run();
  await db.prepare(`INSERT INTO player_sessions (token_hash, player_id, created_at_ms, expires_at_ms, revoked_at_ms)
    VALUES (?, ?, ?, ?, NULL)`).bind(tokenHash, playerId, nowMs, expiresAtMs).run();
  return { token, playerId, expiresAtMs };
}

export async function resolvePlayerSession(
  db: SessionDatabase, token: string | null | undefined, nowMs = Date.now(),
): Promise<PlayerSession | null> {
  if (typeof token !== 'string' || !isSessionToken(token) || !validClock(nowMs)) return null;
  const tokenHash = await digestToken(token);
  const row = await db.prepare(`SELECT player_id, expires_at_ms FROM player_sessions
    WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`).bind(tokenHash, nowMs)
    .first<{ player_id: string; expires_at_ms: number }>();
  if (!row || typeof row.player_id !== 'string' || !Number.isSafeInteger(row.expires_at_ms)) return null;
  return { playerId: row.player_id, expiresAtMs: row.expires_at_ms };
}

export async function revokePlayerSession(
  db: SessionDatabase, token: string | null | undefined, nowMs = Date.now(),
): Promise<boolean> {
  if (typeof token !== 'string' || !isSessionToken(token) || !validClock(nowMs)) return false;
  const tokenHash = await digestToken(token);
  const result = await db.prepare(`UPDATE player_sessions SET revoked_at_ms = ?
    WHERE token_hash = ? AND revoked_at_ms IS NULL`).bind(nowMs, tokenHash).run();
  return (result.meta?.changes ?? 0) > 0;
}
