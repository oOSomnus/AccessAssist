import { expect, test } from '@playwright/test';
import {
  announcements,
  launch,
  openFixture,
  openPanel,
  sendText,
} from './helpers.js';

const MODELS = {
  models: [
    { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' },
    { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list' },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
  ],
};

function sse(...events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

// OpenAI's endpoints are never reached: the panel's requests are answered here.
async function routeOpenAI(context, responses) {
  await context.route('https://api.openai.com/v1/models', (route) => {
    responses.models.push(route.request().headers().authorization);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MODELS) });
  });
  await context.route('https://api.openai.com/v1/responses', (route) => {
    const request = route.request();
    responses.turns.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse(
        { type: 'response.output_text.delta', delta: 'Plan' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Plan answer from ChatGPT.' }] }],
          },
        },
      ),
    });
  });
  // The worker's own calls to the sign-in service: stand-ins.
  await context.route('https://auth.openai.com/.well-known/openid-configuration', (route) => {
    responses.auth.push('discovery');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' }),
    });
  });
  await context.route('https://auth.openai.com/api/accounts/oauth/revoke', (route) => {
    responses.auth.push(`revoke ${new URLSearchParams(route.request().postData() ?? '').get('token')}`);
    return route.fulfill({ status: 200, body: '' });
  });
}

// Routing does not reach the first navigation of a tab the extension opens,
// so OpenAI's hosts resolve to a closed local port: nothing can leave the
// machine even when a request slips past the routes above.
const OFFLINE = ['--host-resolver-rules=MAP auth.openai.com 127.0.0.1:9, MAP api.openai.com 127.0.0.1:9'];

// The sign-in tab's authorize address, from the worker: the tab opens blank
// and an error page hides the address from the page object, so wait for it
// and keep the value once seen.
async function signInTabUrl(worker) {
  let seen = null;
  await expect.poll(async () => {
    seen = await worker.evaluate(async () => {
      const { chatgptPending } = await chrome.storage.session.get('chatgptPending');
      if (!chatgptPending?.tabId) return null;
      const tab = await chrome.tabs.get(chatgptPending.tabId).catch(() => null);
      return [tab?.pendingUrl, tab?.url].find((url) => url?.startsWith('https://auth.openai.com/')) ?? null;
    });
    return seen;
  }).toMatch(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/u);
  return seen;
}

async function openSettings(panel) {
  if (await panel.locator('#settings').isHidden()) await panel.locator('#settings-toggle').click();
}

test('ChatGPT plan: sign-in tab, model and effort choice, a plan-funded turn, and sign-out', async () => {
  const { context, extensionId, worker } = await launch({ args: OFFLINE });
  const responses = { models: [], turns: [], auth: [] };
  try {
    await routeOpenAI(context, responses);
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    const keyBefore = (await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey;
    await openSettings(panel);

    // Choosing the service swaps the controls; numbers follow what is shown.
    await panel.locator('#service').selectOption('chatgpt');
    await expect(panel.locator('#api-key')).toBeHidden();
    await expect(panel.locator('#advanced-api')).toBeHidden();
    await expect(panel.locator('#chatgpt-sign-in')).toBeVisible();
    await expect(panel.locator('#chatgpt-sign-in')).toHaveText('1 Continue with ChatGPT');

    // Saving before signing in is refused and says why.
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('sign in with ChatGPT first');
    await expect(panel.locator('#chatgpt-sign-in')).toBeFocused();

    // Control+Shift+1 presses the visible number 1: the sign-in button.
    const signInTab = context.waitForEvent('page');
    await panel.keyboard.press('Control+Shift+Digit1');
    const authPage = await signInTab;
    const params = new URL(await signInTabUrl(worker)).searchParams;
    expect(params.get('client_id')).toBe('dynamic_agent_client');
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(params.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(params.get('ext_agent_host_id')).toMatch(/^urn:uuid:/u);
    await expect.poll(() => announcements(panel)).toContain('ChatGPT sign-in is open in this tab. AccessAssist does not read it.');
    expect(await announcements(panel)).not.toContain('not a regular web page');
    await expect(panel.locator('#settings-status')).toContainText('ChatGPT sign-in is open in a new tab');

    // The sign-in tab is never readable, even though it is an https page.
    const info = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://auth.openai.com/*' });
      return chrome.runtime.sendMessage({ type: 'GET_TAB_INFO', tabId: tab.id });
    });
    expect(info.readable).toBe(false);
    const observed = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://auth.openai.com/*' });
      return chrome.runtime.sendMessage({ type: 'OBSERVE_PAGE', tabId: tab.id });
    });
    expect(observed.error).toBeTruthy();

    // Closing the tab cancels the attempt; the panel says so and returns focus.
    await authPage.close();
    await expect.poll(() => announcements(panel)).toContain('Sign-in was cancelled');
    await expect(panel.locator('#chatgpt-sign-in')).toBeFocused();
    expect((await worker.evaluate(() => chrome.storage.local.get('chatgptAuth'))).chatgptAuth).toBeUndefined();

    // A finished sign-in, in the order the worker records it after the token
    // exchange (covered by the unit tests): store the grant, leave the tab,
    // then publish the outcome.
    const second = context.waitForEvent('page');
    await panel.evaluate(() => { document.getElementById('chatgpt-sign-in').click(); });
    const secondPage = await second;
    await signInTabUrl(worker);
    await worker.evaluate(async () => {
      await chrome.storage.session.remove('chatgptPending');
      await chrome.storage.session.set({ chatgptAccess: { token: 'at-e2e', expiresAt: Date.now() + 3_600_000 } });
      await chrome.storage.local.set({ chatgptAuth: { clientId: 'oaiapp_e2e', refreshToken: 'rt-e2e', email: 'person@example.test' } });
    });
    await secondPage.close();
    await worker.evaluate(() => chrome.storage.session.set({
      chatgptSignIn: { status: 'done', message: 'Signed in.', at: Date.now(), email: 'person@example.test' },
    }));
    await expect.poll(() => announcements(panel)).toContain('Signed in to ChatGPT as person@example.test');
    await expect(panel.locator('#chatgpt-account')).toHaveText('Signed in to ChatGPT as person@example.test.');
    await expect(panel.locator('#chatgpt-model')).toBeFocused();
    await expect(panel.locator('#chatgpt-model option')).toHaveText(['GPT A', 'GPT B']);
    await expect(panel.locator('#chatgpt-model')).toHaveValue('gpt-a');
    expect(responses.models.at(-1)).toBe('Bearer at-e2e');
    await expect(panel.locator('#chatgpt-sign-out')).toHaveText('3 Sign out of ChatGPT');

    await panel.locator('#chatgpt-model').selectOption('gpt-b');
    await panel.locator('#chatgpt-effort').selectOption('xhigh');
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    expect((await panel.evaluate(() => chrome.storage.local.get('apiConfig'))).apiConfig)
      .toEqual({ protocol: 'chatgpt', baseUrl: 'https://api.openai.com/v1', model: 'gpt-b', effort: 'xhigh' });
    // The OpenCode key stays for when the person switches back.
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore);

    await sendText(panel, 'Say hello');
    await expect(panel.locator('#transcript')).toContainText('Plan answer from ChatGPT.', { timeout: 30_000 });
    const turn = responses.turns.at(-1);
    expect(turn.authorization).toBe('Bearer at-e2e');
    expect(turn.body).toMatchObject({ model: 'gpt-b', store: false, stream: true, reasoning: { effort: 'xhigh' } });
    expect(turn.body.max_output_tokens).toBeUndefined();
    expect(typeof turn.body.instructions).toBe('string');

    // Back to the key: the earlier configuration and key return.
    await openSettings(panel);
    await panel.locator('#service').selectOption('key');
    await expect(panel.locator('#api-key')).toBeVisible();
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    expect((await panel.evaluate(() => chrome.storage.local.get('apiConfig'))).apiConfig.protocol).toBe('openai');
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore);

    // Sign out forgets the account.
    await panel.locator('#service').selectOption('chatgpt');
    await panel.locator('#chatgpt-sign-out').click();
    await expect.poll(() => announcements(panel)).toContain('Signed out of ChatGPT.');
    expect(responses.auth).toEqual(['discovery', 'revoke rt-e2e']);
    await expect(panel.locator('#chatgpt-sign-in')).toBeFocused();
    expect((await worker.evaluate(() => chrome.storage.local.get('chatgptAuth'))).chatgptAuth).toBeUndefined();
  } finally {
    await context.close();
  }
});

// The whole path through the worker: the sign-in tab is redirected to the
// loopback callback, the worker exchanges the code, closes the tab and returns
// to the page. (Playwright's routed redirect may not reproduce every way a
// real server redirect reports itself; the worker watches several signals.)
test('ChatGPT plan: a redirect to the callback finishes sign-in and returns to the page', async () => {
  const { context, extensionId, worker } = await launch({ args: OFFLINE });
  const responses = { models: [], turns: [], auth: [] };
  try {
    await routeOpenAI(context, responses);
    let nonce = null;
    await context.route('https://auth.openai.com/api/accounts/oauth/token', (route) => {
      const form = new URLSearchParams(route.request().postData() ?? '');
      responses.auth.push(`token ${form.get('grant_type')} ${form.get('client_id')} ${form.get('code')}`);
      const claims = Buffer.from(JSON.stringify({
        iss: 'https://auth.openai.com', aud: 'oaiapp_e2e', exp: Math.floor(Date.now() / 1000) + 3600, nonce, email: 'redirect@example.test', sub: 'u',
      })).toString('base64url');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'at-redirect',
          refresh_token: 'rt-redirect',
          id_token: `e30.${claims}.sig`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        }),
      });
    });
    const article = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await openSettings(panel);
    await panel.locator('#service').selectOption('chatgpt');
    const opened = context.waitForEvent('page');
    await panel.locator('#chatgpt-sign-in').click();
    const authPage = await opened;
    const params = new URL(await signInTabUrl(worker)).searchParams;
    nonce = params.get('nonce');
    const callback = new URL(params.get('redirect_uri'));
    callback.search = new URLSearchParams({ code: 'code-e2e', state: params.get('state'), client_id: 'oaiapp_e2e', scope: 'openid' }).toString();
    // What OpenAI does after consent: answer with a redirect to the callback.
    await authPage.route('http://127.0.0.1:4173/consent-done', (route) => route.fulfill({ status: 302, headers: { location: callback.href } }));
    await authPage.goto('http://127.0.0.1:4173/consent-done').catch(() => {});

    await expect.poll(() => announcements(panel)).toContain('Signed in to ChatGPT as redirect@example.test');
    expect(responses.auth).toEqual(['token authorization_code oaiapp_e2e code-e2e']);
    // The sign-in tab is gone and the page the person started from is in front.
    expect(authPage.isClosed()).toBe(true);
    expect(await article.evaluate(() => document.visibilityState)).toBe('visible');
    const stored = await worker.evaluate(() => chrome.storage.local.get('chatgptAuth'));
    expect(stored.chatgptAuth).toMatchObject({ clientId: 'oaiapp_e2e', refreshToken: 'rt-redirect', email: 'redirect@example.test' });
    await expect(panel.locator('#chatgpt-model')).toBeFocused();
    await expect(panel.locator('#chatgpt-model option')).toHaveText(['GPT A', 'GPT B']);
    expect(responses.models.at(-1)).toBe('Bearer at-redirect');
  } finally {
    await context.close();
  }
});
