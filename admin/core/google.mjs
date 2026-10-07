// "Login with Gmail": OpenID Connect authorization-code flow with PKCE.
// Only verified Google accounts listed in ADMIN_GOOGLE_EMAILS get in.
//
// The ID token is received directly from Google's token endpoint over TLS, in
// exchange for a one-time code plus our client secret and PKCE verifier, so per
// OpenID Connect Core §3.1.3.7 its claims can be trusted without verifying the
// JWT signature. All other required claim checks are done below.
//
// The flow is stateless: state, nonce and PKCE verifier travel in a signed,
// HttpOnly, 10-minute cookie, so it works across server restarts and instances.
import crypto from 'node:crypto';
import { randomToken } from './session.mjs';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const OAUTH_TTL_SECONDS = 10 * 60;
const PURPOSE = 'google-oauth';

export class GoogleAuthError extends Error {}

export function createGoogleAuth(google, { codec, fetchImpl = fetch }) {
  return {
    /** Returns the Google URL to send the browser to, and the signed cookie to set. */
    start() {
      const state = randomToken();
      const verifier = randomToken(48);
      const nonce = randomToken();
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: google.redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
        ...(google.allowedEmails.size === 1 ? { login_hint: [...google.allowedEmails][0] } : {}),
      }).toString();
      return { url: url.href, cookie: codec.sign(PURPOSE, { state, verifier, nonce }, OAUTH_TTL_SECONDS) };
    },

    /** Completes sign-in and returns the verified, allowed email address. */
    async finish({ code, state, cookie }) {
      if (!code || !state) throw new GoogleAuthError('Sign-in was cancelled.');
      const pending = codec.verify(PURPOSE, cookie);
      // The state must match the cookie set in *this* browser (CSRF / login fixation).
      if (!pending || pending.state !== state) throw new GoogleAuthError('Sign-in expired. Please try again.');

      let response;
      try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: google.clientId,
            client_secret: google.clientSecret,
            redirect_uri: google.redirectUri,
            grant_type: 'authorization_code',
            code_verifier: pending.verifier,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new GoogleAuthError('Could not reach Google. Please try again.');
      }
      const json = await response.json().catch(() => ({}));
      if (!response.ok || typeof json.id_token !== 'string') {
        console.warn(`[auth] Google token exchange failed: ${json.error || response.status} ${json.error_description || ''}`);
        throw new GoogleAuthError('Google did not accept the sign-in. Please try again.');
      }

      let claims;
      try {
        claims = JSON.parse(Buffer.from(json.id_token.split('.')[1], 'base64url').toString('utf-8'));
      } catch {
        throw new GoogleAuthError('Google returned an unreadable sign-in token.');
      }
      const now = Math.floor(Date.now() / 1000);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!ISSUERS.has(claims.iss)
        || !audience.includes(google.clientId)
        || (audience.length > 1 && claims.azp !== google.clientId)
        || typeof claims.exp !== 'number' || claims.exp < now - 60
        || claims.nonce !== pending.nonce) {
        throw new GoogleAuthError('Google sign-in token failed verification.');
      }

      const email = String(claims.email || '').toLowerCase();
      if (claims.email_verified !== true || !google.allowedEmails.has(email)) {
        console.warn(`[auth] sign-in refused for ${email || '(no email)'}`);
        throw new GoogleAuthError('This account does not have access.');
      }
      return email;
    },
  };
}
