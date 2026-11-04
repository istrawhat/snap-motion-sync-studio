// Google sign-in via Chrome's official identity API (chrome.identity.launchWebAuthFlow).
// - The user signs in on Google's own page. The extension never sees a password or cookie.
// - The access token lives only in chrome.storage.session (memory, cleared when the browser closes).
// - The token is only ever sent to Google (googleapis.com).

import { getSettings } from './settings.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export class SetupError extends Error {
  constructor(message) { super(message); this.name = 'SetupError'; }
}
export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

let inflight = null;

export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

export async function getToken({ interactive = false } = {}) {
  const { auth } = await chrome.storage.session.get('auth');
  if (auth && auth.token && auth.expiresAt - 120000 > Date.now()) return auth.token;

  if (inflight) {
    try { return await inflight; } catch (e) { if (!interactive) throw e; }
  }

  inflight = (async () => {
    const { clientId } = await getSettings();
    if (!clientId) {
      throw new SetupError('One-time setup needed: add your Google Client ID in the extension settings.');
    }
    const { authHint } = await chrome.storage.local.get('authHint');
    try {
      return await webAuth(clientId, false, authHint);
    } catch (e) {
      if (!interactive) throw new AuthError('Sign in with Google to continue.');
      return await webAuth(clientId, true, authHint);
    }
  })();

  try { return await inflight; } finally { inflight = null; }
}

async function webAuth(clientId, interactive, hint) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri(),
    scope: SCOPE,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none'
  });
  if (hint) params.set('login_hint', hint);

  let resultUrl;
  try {
    const opts = { url: `${AUTH_URL}?${params}`, interactive };
    if (!interactive) Object.assign(opts, { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 });
    resultUrl = await chrome.identity.launchWebAuthFlow(opts);
  } catch (e) {
    throw new AuthError(interactive
      ? `Google sign-in did not complete (${e?.message || e}).`
      : 'Silent sign-in failed.');
  }
  if (!resultUrl) throw new AuthError('Google sign-in did not complete.');

  const frag = new URLSearchParams(new URL(resultUrl).hash.slice(1));
  const err = frag.get('error');
  if (err) throw new AuthError(`Google sign-in error: ${err}`);
  const token = frag.get('access_token');
  if (!token) throw new AuthError('Google did not return an access token.');
  const expiresIn = Number(frag.get('expires_in')) || 3600;
  await chrome.storage.session.set({ auth: { token, expiresAt: Date.now() + expiresIn * 1000 } });
  return token;
}

export async function invalidateToken() {
  await chrome.storage.session.remove('auth');
}

export async function rememberAccount(email) {
  if (email) await chrome.storage.local.set({ authHint: email });
}

export async function signOut() {
  await chrome.storage.session.remove('auth');
  await chrome.storage.local.remove('authHint');
}
