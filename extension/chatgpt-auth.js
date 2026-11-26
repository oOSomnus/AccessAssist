// Sign in with ChatGPT (OpenAI's open-source token sharing flow). The person's
// ChatGPT plan pays for model requests; AccessAssist never sees a password.
//
// Spec: https://developers.openai.com/siwc/token-sharing-open-source/
// - First sign-in registers a client: client_id=dynamic_agent_client, and the
//   callback returns the issued client_id. Later sign-ins and every refresh
//   use the issued one.
// - PKCE S256, fresh state and nonce per attempt, a loopback redirect on
//   127.0.0.1 where only the port may vary.
// - Access tokens last an hour; refresh tokens rotate on every refresh, so
//   refreshes must never race.
//
// The service worker owns this store: it is the only context that sees the
// redirect (through webNavigation) and the only one that refreshes, so two
// panels can never spend the same rotating refresh token.
import { ApiError } from './ai.js';

export const AUTH_ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
export const DISCOVERY_URL = `${AUTH_ISSUER}/.well-known/openid-configuration`;
export const CHATGPT_API_BASE = 'https://api.openai.com/v1';
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const AGENT_NAME = 'AccessAssist';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
// Refresh a little before expiry so a long model request never starts with a
// token that dies halfway through.
const REFRESH_MARGIN_MS = 5 * 60_000;

// Storage keys. Local survives restarts (the user chose to stay signed in);
// session holds the short-lived access token and the in-flight attempt.
export const KEYS = Object.freeze({
  hostId: 'chatgptHostId',
  auth: 'chatgptAuth',
  access: 'chatgptAccess',
  pending: 'chatgptPending',
  outcome: 'chatgptSignIn',
});

// Refresh errors after which the grant is gone and only a new sign-in helps.
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export function redirectUri(port = CALLBACK_PORT) {
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function randomToken(cryptoImpl, size = 32) {
  return base64url(cryptoImpl.getRandomValues(new Uint8Array(size)));
}

export async function createPkce(cryptoImpl = globalThis.crypto) {
  const verifier = randomToken(cryptoImpl, 32);
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    state: randomToken(cryptoImpl, 24),
    nonce: randomToken(cryptoImpl, 24),
  };
}

export function authorizeUrl({ clientId, hostId, challenge, state, nonce, port = CALLBACK_PORT, idTokenHint, loginHint }) {
  const registering = !clientId;
  const params = new URLSearchParams({
    client_id: clientId || DYNAMIC_CLIENT,
    response_type: 'code',
    redirect_uri: redirectUri(port),
    scope: SCOPES,
    resource: CHATGPT_API_BASE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: hostId,
  });
  if (registering) params.set('agent_name_hint', AGENT_NAME);
  else {
    if (idTokenHint) params.set('id_token_hint', idTokenHint);
    if (loginHint) params.set('login_hint', loginHint);
  }
  return `${AUTHORIZE_URL}?${params}`;
}

// Is this navigation the loopback redirect for the given port?
export function isCallbackUrl(value, port = CALLBACK_PORT) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === CALLBACK_HOST
      && Number(url.port) === port && url.pathname === CALLBACK_PATH;
  } catch {
    return false;
  }
}

// Reads the redirect. Errors are plain sentences for the person; codes and
// state values never go into them.
export function parseCallback(value, { state, port = CALLBACK_PORT, savedClientId = null }) {
  if (!isCallbackUrl(value, port)) return { error: 'The sign-in returned to an unexpected address.' };
  const params = new URL(value).searchParams;
  if (params.get('state') !== state) return { error: 'The sign-in response did not match this attempt. Try again.' };
  const failure = params.get('error');
  if (failure === 'access_denied') return { error: 'Sign-in was declined, so nothing was saved.', declined: true };
  if (failure) return { error: 'ChatGPT reported a sign-in error. Try again.' };
  const code = params.get('code');
  if (!code) return { error: 'The sign-in response had no authorization code. Try again.' };
  const returned = params.get('client_id');
  if (savedClientId) {
    // A reauthorization may omit the id; a different one is not ours.
    if (returned && returned !== savedClientId) return { error: 'The sign-in returned a different app registration. Try again.' };
    return { code, clientId: savedClientId };
  }
  if (!returned || returned === DYNAMIC_CLIENT) return { error: 'ChatGPT did not finish registering AccessAssist. Try again.' };
  return { code, clientId: returned };
}

// Display and nonce check only. The token comes straight from the token
// endpoint over TLS, so its signature is not what protects us here.
export function idTokenClaims(idToken) {
  try {
    const [, payload] = String(idToken).split('.');
    const json = atob(payload.replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function epochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  // Seconds, as JWT and OAuth use, unless it already looks like milliseconds.
  return number < 1e12 ? number * 1000 : number;
}

async function postForm(fetchImpl, url, fields) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (error) {
    throw new ApiError('network', 'Could not reach ChatGPT sign-in', { cause: String(error?.message ?? error) });
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, ok: response.ok, json };
}

function oauthError(json) {
  const code = json?.error?.code ?? json?.error;
  return typeof code === 'string' ? code : null;
}

// Token response to what we keep. Missing pieces are failures, not guesses.
function tokensFrom(json, now) {
  if (!json?.access_token || typeof json.access_token !== 'string') {
    throw new ApiError('auth', 'ChatGPT sign-in returned no access token');
  }
  const expiresIn = Number(json.expires_in);
  return {
    access: {
      token: json.access_token,
      expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000),
    },
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
    earliestRefreshAt: epochMs(json.earliest_refresh_at),
    scope: typeof json.scope === 'string' ? json.scope : '',
  };
}

export function createChatgptAuth({
  local,
  session,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  port = CALLBACK_PORT,
}) {
  let queue = Promise.resolve();

  async function read(area, key) {
    const stored = await area.get(key);
    return stored?.[key] ?? null;
  }

  // One install, one host id, kept across sign-outs: the spec asks for the
  // same value for the same host.
  async function hostId() {
    const existing = await read(local, KEYS.hostId);
    if (typeof existing === 'string' && existing) return existing;
    const created = `urn:uuid:${cryptoImpl.randomUUID()}`;
    await local.set({ [KEYS.hostId]: created });
    return created;
  }

  async function status() {
    const auth = await read(local, KEYS.auth);
    return { signedIn: Boolean(auth?.refreshToken), email: auth?.email ?? null };
  }

  async function pending() {
    const entry = await read(session, KEYS.pending);
    if (!entry) return null;
    if (now() - (entry.at ?? 0) > SIGN_IN_TIMEOUT_MS) {
      await session.remove(KEYS.pending);
      await setOutcome('failed', 'Sign-in timed out. Try again.');
      return null;
    }
    return entry;
  }

  async function setOutcome(status, message, extra = {}) {
    await session.set({ [KEYS.outcome]: { status, message, at: now(), ...extra } });
  }

  // Builds the authorize URL and records the attempt. The caller opens the
  // tab and then calls attachTab so the redirect can be matched to it.
  async function startSignIn({ returnTabId = null, windowId = null } = {}) {
    const pkce = await createPkce(cryptoImpl);
    const auth = await read(local, KEYS.auth);
    // A saved registration (from an expired session) is reused, with hints so
    // the account selector can be skipped.
    const clientId = auth?.clientId ?? null;
    const url = authorizeUrl({
      clientId,
      hostId: await hostId(),
      challenge: pkce.challenge,
      state: pkce.state,
      nonce: pkce.nonce,
      port,
      idTokenHint: clientId ? auth?.idToken : null,
      loginHint: clientId ? auth?.email : null,
    });
    await session.set({
      [KEYS.pending]: {
        verifier: pkce.verifier,
        state: pkce.state,
        nonce: pkce.nonce,
        clientId,
        tabId: null,
        returnTabId,
        windowId,
        at: now(),
      },
    });
    await setOutcome('pending', 'Waiting for ChatGPT sign-in.');
    return { url };
  }

  async function attachTab(tabId) {
    const entry = await read(session, KEYS.pending);
    if (!entry) return;
    await session.set({ [KEYS.pending]: { ...entry, tabId } });
  }

  async function signInTabId() {
    return (await pending())?.tabId ?? null;
  }

  // With tabId, cancels only the attempt in that tab, whether or not it has
  // already passed its time limit.
  async function cancelSignIn(message = 'Sign-in was cancelled. Nothing was saved.', { tabId } = {}) {
    const entry = await read(session, KEYS.pending);
    if (!entry || (tabId !== undefined && entry.tabId !== tabId)) return null;
    await session.remove(KEYS.pending);
    await setOutcome('cancelled', message);
    return entry;
  }

  // Finishes the attempt from the redirect URL. beforeOutcome runs once the
  // result is stored but before it is published, so the caller can return the
  // person to their page first: the panel announces the outcome, and a page
  // change arriving after that announcement would cut it off.
  async function completeSignIn(callbackUrl, { beforeOutcome = async () => {} } = {}) {
    const entry = await pending();
    if (!entry) return { error: 'No sign-in is in progress.' };
    await session.remove(KEYS.pending);
    const publish = async (status, message, extra = {}) => {
      await beforeOutcome(entry);
      await setOutcome(status, message, extra);
    };
    const fail = async (message) => {
      await publish('failed', message);
      return { error: message, entry };
    };
    const parsed = parseCallback(callbackUrl, { state: entry.state, port, savedClientId: entry.clientId });
    if (parsed.error) {
      if (parsed.declined) {
        await publish('cancelled', parsed.error);
        return { error: parsed.error, entry };
      }
      return fail(parsed.error);
    }
    let tokens;
    try {
      const reply = await postForm(fetchImpl, TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: parsed.clientId,
        code: parsed.code,
        code_verifier: entry.verifier,
        redirect_uri: redirectUri(port),
        resource: CHATGPT_API_BASE,
      });
      if (!reply.ok) {
        if (oauthError(reply.json) === 'invalid_client') await local.remove(KEYS.auth);
        return fail(`ChatGPT did not accept the sign-in (HTTP ${reply.status}). Try again.`);
      }
      tokens = tokensFrom(reply.json, now());
    } catch (error) {
      return fail(error?.code === 'network' ? 'Could not reach ChatGPT to finish signing in. Check your connection and try again.' : 'ChatGPT returned an unusable sign-in. Try again.');
    }
    const claims = tokens.idToken ? idTokenClaims(tokens.idToken) : null;
    if (!claims || claims.nonce !== entry.nonce) return fail('The sign-in could not be verified. Try again.');
    if (!tokens.refreshToken) return fail('ChatGPT did not allow AccessAssist to stay signed in. Try again.');
    if (!tokens.scope.split(/\s+/u).includes(PLAN_SCOPE)) {
      await revokeToken(parsed.clientId, tokens.refreshToken);
      return fail('ChatGPT did not allow AccessAssist to use your plan, so nothing was saved.');
    }
    const email = typeof claims.email === 'string' ? claims.email : null;
    await local.set({
      [KEYS.auth]: {
        clientId: parsed.clientId,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        email,
        subject: typeof claims.sub === 'string' ? claims.sub : null,
        earliestRefreshAt: tokens.earliestRefreshAt,
        signedInAt: now(),
      },
    });
    await session.set({ [KEYS.access]: tokens.access });
    await publish('done', 'Signed in.', { email });
    return { ok: true, email, entry };
  }

  // Keeps the registration and hints so the next sign-in can reuse them, but
  // drops every token: the grant is gone.
  async function dropTokens({ forgetClient = false } = {}) {
    await session.remove(KEYS.access);
    if (forgetClient) {
      await local.remove(KEYS.auth);
      return;
    }
    const auth = await read(local, KEYS.auth);
    if (auth) {
      const { refreshToken: _dropped, ...rest } = auth;
      await local.set({ [KEYS.auth]: rest });
    }
  }

  async function refresh(auth, { force }) {
    if (!force && auth.earliestRefreshAt && now() < auth.earliestRefreshAt) return null;
    const reply = await postForm(fetchImpl, TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: auth.clientId,
      refresh_token: auth.refreshToken,
      resource: CHATGPT_API_BASE,
    });
    if (!reply.ok) {
      const code = oauthError(reply.json);
      if (code === 'invalid_client') {
        await dropTokens({ forgetClient: true });
        throw new ApiError('signed_out', 'ChatGPT no longer recognizes this sign-in');
      }
      if (TERMINAL_REFRESH_ERRORS.has(code) || reply.status === 401) {
        await dropTokens();
        throw new ApiError('signed_out', 'The ChatGPT sign-in expired');
      }
      throw new ApiError('http', `ChatGPT sign-in service returned an error (HTTP ${reply.status})`);
    }
    const tokens = tokensFrom(reply.json, now());
    // Store the replacement before anything else can read the old one.
    await local.set({
      [KEYS.auth]: {
        ...auth,
        refreshToken: tokens.refreshToken ?? auth.refreshToken,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        earliestRefreshAt: tokens.earliestRefreshAt,
      },
    });
    await session.set({ [KEYS.access]: tokens.access });
    return tokens.access;
  }

  // A usable access token, refreshed when close to expiry or when forced
  // (after the API rejected it). Calls run one at a time, so concurrent
  // callers never spend the same rotating refresh token: the second one finds
  // the token the first one stored.
  async function currentToken({ force }) {
    const auth = await read(local, KEYS.auth);
    if (!auth?.refreshToken || !auth.clientId) throw new ApiError('signed_out', 'Not signed in to ChatGPT');
    const access = await read(session, KEYS.access);
    const fresh = access?.token && access.expiresAt - now() > REFRESH_MARGIN_MS;
    if (fresh && !force) return access.token;
    const renewed = await refresh(auth, { force });
    if (renewed) return renewed.token;
    // Too early to refresh: keep using a token that has not expired yet.
    if (access?.token && access.expiresAt > now()) return access.token;
    throw new ApiError('signed_out', 'The ChatGPT sign-in expired');
  }

  function accessToken({ force = false } = {}) {
    const run = queue.then(() => currentToken({ force }));
    queue = run.catch(() => {});
    return run;
  }

  async function revocationEndpoint() {
    try {
      const response = await fetchImpl(DISCOVERY_URL, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      const json = await response.json();
      const endpoint = typeof json?.revocation_endpoint === 'string' ? new URL(json.revocation_endpoint) : null;
      // Only ever send a refresh token back to the issuer.
      return endpoint && endpoint.origin === AUTH_ISSUER ? endpoint.href : null;
    } catch {
      return null;
    }
  }

  async function revokeToken(clientId, refreshToken) {
    const endpoint = await revocationEndpoint();
    if (!endpoint) return false;
    try {
      const reply = await postForm(fetchImpl, endpoint, {
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      });
      return reply.ok;
    } catch {
      return false;
    }
  }

  // Signing out forgets the account entirely, so a different account can sign
  // in next. Revocation is best effort; the local copy goes regardless.
  // Queued behind any refresh in flight, so a refresh finishing afterwards
  // cannot write the account back.
  function signOut() {
    const run = queue.then(async () => {
      const auth = await read(local, KEYS.auth);
      await dropTokens({ forgetClient: true });
      await session.remove(KEYS.outcome);
      const revoked = auth?.refreshToken && auth.clientId ? await revokeToken(auth.clientId, auth.refreshToken) : true;
      return { revoked };
    });
    queue = run.catch(() => {});
    return run;
  }

  return { status, startSignIn, attachTab, signInTabId, cancelSignIn, completeSignIn, accessToken, signOut, pending };
}
