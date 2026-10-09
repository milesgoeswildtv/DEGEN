/** Telegram Mini App bot-token HMAC verifier. Not wired to Worker auth. */
export type VerifiedTelegramIdentity = { platformUserId: string; displayName: string; authDate: number };

const encoder = new TextEncoder();
const hexBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
};

export async function verifyTelegramInitData(
  raw: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 600,
): Promise<VerifiedTelegramIdentity | null> {
  if (!raw || raw.length > 16384 || !botToken || !Number.isSafeInteger(nowSeconds) ||
      !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const hash = params.get('hash');
  const dateString = params.get('auth_date');
  const userString = params.get('user');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !dateString || !/^\d{1,12}$/.test(dateString) || !userString) return null;
  const authDate = Number(dateString);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) return null;

  const check = [...params.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const key = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', key, encoder.encode(botToken));
  const verifyKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const computed = new Uint8Array(await crypto.subtle.sign('HMAC', verifyKey, encoder.encode(check)));
  if (!constantTimeEqual(computed, hexBytes(hash))) return null;

  let user: unknown;
  try { user = JSON.parse(userString); } catch { return null; }
  if (!user || typeof user !== 'object') return null;
  const parsed = user as { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown };
  if (typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id <= 0) return null;
  const displayName = [parsed.first_name, parsed.last_name].filter((name): name is string => typeof name === 'string').join(' ').trim()
    || (typeof parsed.username === 'string' ? parsed.username : 'Player');
  return { platformUserId: String(parsed.id), displayName: displayName.slice(0, 32), authDate };
}
