import { digestToken, type SessionDatabase } from './sessionStore.ts';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_TTL_MS = 2 * 60 * 1000;

function tokenFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function issueDiscordChallenge(db: SessionDatabase, nowMs = Date.now()): Promise<{ state: string; expiresAtMs: number }> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid challenge clock.');
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const state = tokenFromBytes(bytes);
  const expiresAtMs = nowMs + STATE_TTL_MS;
  await db.prepare('DELETE FROM auth_nonces WHERE expires_at_ms <= ? OR consumed_at_ms IS NOT NULL').bind(nowMs).run();
  await db.prepare(`INSERT INTO auth_nonces (nonce_hash, created_at_ms, expires_at_ms, consumed_at_ms)
    VALUES (?, ?, ?, NULL)`).bind(await digestToken(state), nowMs, expiresAtMs).run();
  return { state, expiresAtMs };
}

export async function consumeDiscordChallenge(
  db: SessionDatabase, state: string | null | undefined, nowMs = Date.now(),
): Promise<boolean> {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state) || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  const result = await db.prepare(`UPDATE auth_nonces SET consumed_at_ms = ?
    WHERE nonce_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
    RETURNING nonce_hash`).bind(nowMs, await digestToken(state), nowMs).first<{ nonce_hash: string }>();
  return Boolean(result?.nonce_hash);
}
