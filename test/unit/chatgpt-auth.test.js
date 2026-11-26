import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORIZE_URL,
  CHATGPT_API_BASE,
  DISCOVERY_URL,
  DYNAMIC_CLIENT,
  KEYS,
  PLAN_SCOPE,
  SCOPES,
  SIGN_IN_TIMEOUT_MS,
  TOKEN_URL,
  authorizeUrl,
  createChatgptAuth,
  createPkce,
  idTokenClaims,
  isCallbackUrl,
  parseCallback,
  redirectUri,
} from '../../extension/chatgpt-auth.js';

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (key == null) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((name) => name in data).map((name) => [name, structuredClone(data[name])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete data[name]; },
  };
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tokenReply({ nonce, scope = SCOPES, refresh = 'rt-1', access = 'at-1', email = 'person@example.test', extra = {} } = {}) {
  return {
    access_token: access,
    refresh_token: refresh,
    id_token: idToken({ nonce, email, sub: 'user-1' }),
    token_type: 'Bearer',
    expires_in: 3600,
    scope,
    ...extra,
  };
}

function setup({ fetchImpl, local = area(), session = area(), clock = { now: 1_000_000 } } = {}) {
  const calls = [];
  const auth = createChatgptAuth({
    local,
    session,
    now: () => clock.now,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init, form: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
      return fetchImpl(url, init, calls);
    },
  });
  return { auth, calls, local, session, clock };
}

async function startedFlow(options = {}) {
  const ctx = setup(options);
  const { url } = await ctx.auth.startSignIn({ returnTabId: 7, windowId: 3 });
  await ctx.auth.attachTab(42);
  const params = new URL(url).searchParams;
  return { ...ctx, url, params, state: params.get('state'), nonce: params.get('nonce') };
}

test('PKCE challenge is the base64url SHA-256 of the verifier', async () => {
  const pkce = await createPkce();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier));
  assert.equal(pkce.challenge, Buffer.from(digest).toString('base64url'));
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(pkce.state, pkce.nonce);
});

test('first sign-in registers with the dynamic client and names the app', () => {
  const url = new URL(authorizeUrl({ hostId: 'urn:uuid:h', challenge: 'c', state: 's', nonce: 'n' }));
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  const params = url.searchParams;
  assert.equal(params.get('client_id'), DYNAMIC_CLIENT);
  assert.equal(params.get('agent_name_hint'), 'AccessAssist');
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(params.get('resource'), CHATGPT_API_BASE);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('ext_agent_host_id'), 'urn:uuid:h');
  assert.ok(params.get('scope').split(' ').includes(PLAN_SCOPE));
  assert.equal(params.get('id_token_hint'), null);
});

test('reauthorization reuses the issued client with account hints', () => {
  const params = new URL(authorizeUrl({
    clientId: 'oaiapp_1', hostId: 'h', challenge: 'c', state: 's', nonce: 'n', idTokenHint: 'idt', loginHint: 'a@b.test',
  })).searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_1');
  assert.equal(params.get('agent_name_hint'), null);
  assert.equal(params.get('id_token_hint'), 'idt');
  assert.equal(params.get('login_hint'), 'a@b.test');
});

test('callbacks are matched exactly and validated', () => {
  const base = redirectUri();
  assert.equal(isCallbackUrl(`${base}?code=x`), true);
  assert.equal(isCallbackUrl('http://localhost:1455/auth/callback?code=x'), false);
  assert.equal(isCallbackUrl('http://127.0.0.1:1455/callback?code=x'), false);
  assert.equal(isCallbackUrl('http://127.0.0.1:1456/auth/callback?code=x'), false);

  assert.deepEqual(parseCallback(`${base}?code=c&state=s&client_id=oaiapp_1`, { state: 's' }), { code: 'c', clientId: 'oaiapp_1' });
  assert.match(parseCallback(`${base}?code=c&state=other&client_id=oaiapp_1`, { state: 's' }).error, /did not match/u);
  assert.equal(parseCallback(`${base}?error=access_denied&state=s`, { state: 's' }).declined, true);
  assert.match(parseCallback(`${base}?code=c&state=s`, { state: 's' }).error, /registering/u);
  assert.match(parseCallback(`${base}?code=c&state=s&client_id=${DYNAMIC_CLIENT}`, { state: 's' }).error, /registering/u);
  // Reauthorization may omit the id but must not swap it.
  assert.deepEqual(parseCallback(`${base}?code=c&state=s`, { state: 's', savedClientId: 'oaiapp_1' }), { code: 'c', clientId: 'oaiapp_1' });
  assert.match(parseCallback(`${base}?code=c&state=s&client_id=oaiapp_2`, { state: 's', savedClientId: 'oaiapp_1' }).error, /different/u);
});

test('ID token claims decode for display, and garbage is null', () => {
  assert.equal(idTokenClaims(idToken({ email: 'é@example.test' })).email, 'é@example.test');
  assert.equal(idTokenClaims('not-a-jwt'), null);
});

test('a completed sign-in exchanges the code and stores a remembered grant', async () => {
  // The nonce is only known once the attempt starts.
  let nonce;
  const flow = await startedFlow({ fetchImpl: async () => json(tokenReply({ nonce })) });
  nonce = flow.nonce;
  const hostId = flow.local.data[KEYS.hostId];
  assert.match(hostId, /^urn:uuid:/u);
  assert.equal(flow.params.get('ext_agent_host_id'), hostId);
  assert.equal(await flow.auth.signInTabId(), 42);

  const result = await flow.auth.completeSignIn(`${redirectUri()}?code=the-code&state=${flow.state}&client_id=oaiapp_9`);
  assert.equal(result.ok, true);
  assert.equal(result.entry.returnTabId, 7);
  const exchange = flow.calls.find((call) => call.url === TOKEN_URL);
  assert.equal(exchange.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(exchange.form, {
    grant_type: 'authorization_code',
    client_id: 'oaiapp_9',
    code: 'the-code',
    code_verifier: exchange.form.code_verifier,
    redirect_uri: redirectUri(),
    resource: CHATGPT_API_BASE,
  });
  assert.ok(exchange.form.code_verifier.length >= 43);
  assert.equal(flow.local.data[KEYS.auth].clientId, 'oaiapp_9');
  assert.equal(flow.local.data[KEYS.auth].refreshToken, 'rt-1');
  assert.equal(flow.local.data[KEYS.auth].email, 'person@example.test');
  assert.deepEqual(flow.session.data[KEYS.access], { token: 'at-1', expiresAt: 1_000_000 + 3_600_000 });
  assert.equal(flow.session.data[KEYS.outcome].status, 'done');
  assert.equal(flow.session.data[KEYS.pending], undefined);
  assert.deepEqual(await flow.auth.status(), { signedIn: true, email: 'person@example.test' });
  // The host id survives and is reused.
  await flow.auth.startSignIn();
  assert.equal(flow.local.data[KEYS.hostId], hostId);
});

test('a sign-in without plan scope, nonce match, or refresh token saves nothing', async () => {
  for (const [reply, pattern] of [
    [(nonce) => tokenReply({ nonce, scope: 'openid profile email offline_access' }), /use your plan/u],
    [() => tokenReply({ nonce: 'wrong' }), /verified/u],
    [(nonce) => tokenReply({ nonce, refresh: null }), /stay signed in/u],
  ]) {
    let nonce;
    const flow = await startedFlow({
      fetchImpl: async (url) => {
        if (url === DISCOVERY_URL) return json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
        if (url === TOKEN_URL) return json(reply(nonce));
        return json({}, 200);
      },
    });
    nonce = flow.nonce;
    const result = await flow.auth.completeSignIn(`${redirectUri()}?code=c&state=${flow.state}&client_id=oaiapp_1`);
    assert.match(result.error, pattern);
    assert.equal(flow.local.data[KEYS.auth], undefined);
    assert.equal(flow.session.data[KEYS.access], undefined);
    assert.equal(flow.session.data[KEYS.outcome].status, 'failed');
  }
});

test('a declined or mismatched callback never reaches the token endpoint', async () => {
  const flow = await startedFlow({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  const declined = await flow.auth.completeSignIn(`${redirectUri()}?error=access_denied&state=${flow.state}`);
  assert.match(declined.error, /declined/u);
  assert.equal(flow.session.data[KEYS.outcome].status, 'cancelled');
  assert.equal(flow.calls.length, 0);

  const again = await startedFlow({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  const forged = await again.auth.completeSignIn(`${redirectUri()}?code=c&state=forged&client_id=oaiapp_1`);
  assert.match(forged.error, /did not match/u);
  assert.equal(again.calls.length, 0);
});

test('an abandoned attempt times out and a closed tab cancels it', async () => {
  const flow = await startedFlow({ fetchImpl: async () => json({}) });
  flow.clock.now += SIGN_IN_TIMEOUT_MS + 1;
  assert.equal(await flow.auth.signInTabId(), null);
  assert.equal(flow.session.data[KEYS.outcome].status, 'failed');

  const other = await startedFlow({ fetchImpl: async () => json({}) });
  // A cancel aimed at another tab leaves this attempt alone.
  assert.equal(await other.auth.cancelSignIn(undefined, { tabId: 99 }), null);
  assert.equal(await other.auth.signInTabId(), 42);
  const entry = await other.auth.cancelSignIn(undefined, { tabId: 42 });
  assert.equal(entry.tabId, 42);
  assert.equal(other.session.data[KEYS.outcome].status, 'cancelled');
  assert.equal(await other.auth.cancelSignIn(), null);
});

function signedIn({ fetchImpl, access = { token: 'at-old', expiresAt: 1_000_000 + 3_600_000 }, auth = {} }) {
  const local = area({ [KEYS.auth]: { clientId: 'oaiapp_1', refreshToken: 'rt-old', email: 'p@example.test', ...auth } });
  const session = area(access ? { [KEYS.access]: access } : {});
  return setup({ fetchImpl, local, session });
}

test('a fresh token is reused and a near-expiry one refreshes once for concurrent callers', async () => {
  const fresh = signedIn({ fetchImpl: async () => { throw new Error('no refresh expected'); } });
  assert.equal(await fresh.auth.accessToken(), 'at-old');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = signedIn({
    access: { token: 'at-old', expiresAt: 1_000_000 + 60_000 },
    fetchImpl: async () => {
      await gate;
      return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, scope: SCOPES });
    },
  });
  const first = stale.auth.accessToken();
  const second = stale.auth.accessToken();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['at-new', 'at-new']);
  assert.equal(stale.calls.length, 1);
  assert.deepEqual(stale.calls[0].form, {
    grant_type: 'refresh_token',
    client_id: 'oaiapp_1',
    refresh_token: 'rt-old',
    resource: CHATGPT_API_BASE,
  });
  // The rotated refresh token replaces the spent one.
  assert.equal(stale.local.data[KEYS.auth].refreshToken, 'rt-new');
  assert.equal(stale.session.data[KEYS.access].token, 'at-new');
});

test('force refreshes even a fresh token, but not before earliest_refresh_at unless forced', async () => {
  const forced = signedIn({ fetchImpl: async () => json({ access_token: 'at-forced', refresh_token: 'rt-2', expires_in: 3600 }) });
  assert.equal(await forced.auth.accessToken({ force: true }), 'at-forced');

  const early = signedIn({
    access: { token: 'at-old', expiresAt: 1_000_000 + 60_000 },
    auth: { earliestRefreshAt: 1_000_000 + 30_000 },
    fetchImpl: async () => { throw new Error('too early to refresh'); },
  });
  assert.equal(await early.auth.accessToken(), 'at-old');
});

test('a terminal refresh error signs out but keeps the registration for reuse', async () => {
  const ctx = signedIn({
    access: null,
    fetchImpl: async () => json({ error: 'refresh_token_reused' }, 400),
  });
  await assert.rejects(ctx.auth.accessToken(), (error) => error.code === 'signed_out');
  assert.equal(ctx.local.data[KEYS.auth].refreshToken, undefined);
  assert.equal(ctx.local.data[KEYS.auth].clientId, 'oaiapp_1');
  assert.deepEqual(await ctx.auth.status(), { signedIn: false, email: 'p@example.test' });
  const { url } = await ctx.auth.startSignIn();
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_1');
  assert.equal(params.get('login_hint'), 'p@example.test');
});

test('a temporary refresh failure keeps the grant', async () => {
  const ctx = signedIn({ access: null, fetchImpl: async () => json({ error: 'server_error' }, 503) });
  await assert.rejects(ctx.auth.accessToken(), (error) => error.code === 'http');
  assert.equal(ctx.local.data[KEYS.auth].refreshToken, 'rt-old');
});

test('sign-out forgets the account and revokes only at the issuer', async () => {
  const ctx = signedIn({
    fetchImpl: async (url) => {
      if (url === DISCOVERY_URL) return json({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      return new Response('', { status: 200 });
    },
  });
  assert.deepEqual(await ctx.auth.signOut(), { revoked: true });
  assert.equal(ctx.local.data[KEYS.auth], undefined);
  assert.equal(ctx.session.data[KEYS.access], undefined);
  const revoke = ctx.calls.find((call) => call.url.endsWith('/revoke'));
  assert.deepEqual(revoke.form, { token: 'rt-old', token_type_hint: 'refresh_token', client_id: 'oaiapp_1' });

  const elsewhere = signedIn({
    fetchImpl: async (url) => (url === DISCOVERY_URL ? json({ revocation_endpoint: 'https://evil.example/revoke' }) : json({})),
  });
  assert.deepEqual(await elsewhere.auth.signOut(), { revoked: false });
  assert.equal(elsewhere.calls.some((call) => call.url.includes('evil')), false);
  assert.equal(elsewhere.local.data[KEYS.auth], undefined);
});
