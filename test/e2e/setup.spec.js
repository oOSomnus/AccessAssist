import { expect, test } from '@playwright/test';
import {
  emitFinal,
  launch,
  mockRequests,
  openFixture,
  openPanel,
  resetMock,
  sendIntent,
  spoken,
  voiceState,
} from './helpers.js';

test('a sidebar permission failure opens a setup tab that only prepares voice', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'prompt', gum: 'deny' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    const popup = context.waitForEvent('page');
    await sendIntent(worker, { id: 'setup-permission', mode: 'voice', source: 'command', tabId: 0 });
    const setup = await popup;
    await setup.waitForLoadState();
    await expect(setup).toHaveURL(/sidepanel\.html\?setup=1$/);
    await expect(setup.locator('body')).toHaveClass(/setup-page/);
    await expect(setup.locator('#composer')).toBeHidden();
    await expect(setup.locator('.settings')).toBeHidden();
    await expect(setup.locator('#start-using')).toBeVisible();
    await expect(setup.locator('#return-assistant')).toBeHidden();

    await setup.evaluate(() => { window.__aaVoice.gum = 'grant'; });
    await expect(setup.locator('#start-using')).toContainText('1 Prepare voice');
    await setup.keyboard.press('1');
    await expect(setup.locator('#return-assistant')).toBeVisible();
    await expect(setup.locator('#return-assistant')).toContainText('1 Return to assistant');
    await expect(setup.locator('#return-assistant')).toBeFocused();
    expect((await voiceState(setup)).starts).toBe(0);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('only a real setup tab can claim setup completion', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    const result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'COMPLETE_VOICE_SETUP' }));
    expect(result.error).toMatch(/Unauthorized/u);
  } finally {
    await context.close();
  }
});

test('returning from setup prepares the original panel without listening', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'prompt', gum: 'deny' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    const popup = context.waitForEvent('page');
    await sendIntent(worker, { id: 'setup-return', mode: 'voice', source: 'command', tabId: 0 });
    const setup = await popup;
    await setup.waitForLoadState();
    await setup.evaluate(() => {
      window.__aaVoice.gum = 'grant';
      window.__aaVoice.permission = 'granted';
    });
    // The real side panel would be a second, competing panel surface; the tab
    // opened by openPanel stands in for it in these tests.
    await setup.evaluate(() => { chrome.sidePanel.open = async () => {}; });
    await setup.keyboard.press('1');
    await expect(setup.locator('#return-assistant')).toBeFocused();

    // Chrome shares the granted permission with the already open panel.
    await panel.evaluate(() => { window.__aaVoice.permission = 'granted'; });
    const closed = setup.waitForEvent('close');
    await setup.keyboard.press('1');
    await closed;
    await panel.bringToFront();
    // Setup completion only refreshes readiness; the microphone stays closed.
    await expect.poll(async () => await spoken(panel)).toContain('Press Alt+Z to listen.');
    await panel.waitForTimeout(300);
    expect((await voiceState(panel)).starts).toBe(0);

    await sendIntent(worker, { id: 'setup-voice', mode: 'voice', source: 'command', tabId: 0 });
    await expect.poll(async () => (await voiceState(panel)).starts, { timeout: 10_000 }).toBe(1);
    await emitFinal(panel, 'help');
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('a setup tab does not read or clear the stored key', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await panel.close();
    const before = await worker.evaluate(() => chrome.storage.session.get('apiKey'));
    expect(before.apiKey?.value).toBe('test-key');

    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/sidepanel.html?setup=1`);
    await expect(setup.locator('body')).toHaveClass(/setup-page/);
    await expect(setup.locator('#page-line')).toBeHidden();
    await expect(setup.locator('#composer')).toBeHidden();
    await setup.waitForTimeout(300);
    const after = await worker.evaluate(() => chrome.storage.session.get('apiKey'));
    expect(after.apiKey).toEqual(before.apiKey);
  } finally {
    await context.close();
  }
});
