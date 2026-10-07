// Stateless, tamper-proof tokens: base64url(JSON payload) + "." + HMAC-SHA256.
// Used for the login session cookie and the short-lived Google sign-in state.
// Changing SESSION_SECRET signs everyone out.
import crypto from 'node:crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function createTokenCodec(secret) {
  const mac = (purpose, data) => crypto.createHmac('sha256', secret).update(`${purpose}\n${data}`).digest('base64url');

  return {
    /** `purpose` separates token types so one can never be replayed as another. */
    sign(purpose, payload, ttlSeconds) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
      return `${body}.${mac(purpose, body)}`;
    },

    verify(purpose, token) {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra !== undefined) return null;
      const expected = Buffer.from(mac(purpose, body));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
      let payload;
      try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')); } catch { return null; }
      if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    },
  };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Cookie options: __Host- prefix + Secure on HTTPS (forbids subdomain/HTTP overrides). */
export function cookieNames(secure) {
  return {
    session: secure ? '__Host-sapta_session' : 'sapta_session',
    oauth: secure ? '__Host-sapta_oauth' : 'sapta_oauth',
  };
}

export function serializeCookie(name, value, { maxAge, sameSite = 'Strict', secure }) {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');
}
