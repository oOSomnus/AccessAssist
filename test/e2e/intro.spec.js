import { expect, test } from '@playwright/test';
import {
  announcements,
  launch,
  openFirstUsePanel,
  openFixture,
  openPanel,
  resetMock,
  answerWhen,
  sendIntent,
  sendText,
  voiceState,
} from './helpers.js';

const introCount = (text) => text.split('Hi, I am AccessAssist').length - 1;

test('a returning user hears only the replay hint', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect.poll(async () => await announcements(panel)).toContain('hear the introduction again');
    const heard = await announcements(panel);
    expect(heard).not.toContain('Hi, I am AccessAssist');
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('the first introduction is claimed before delivery and is not replayed after interruption', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await openFixture(context, '/article');
    const panel = await openFirstUsePanel(context, extensionId);
    await expect.poll(async () => worker.evaluate(
      async () => (await chrome.storage.local.get('introSeen')).introSeen,
    )).toBe(true);
    await expect.poll(() => announcements(panel)).toContain('Hi, I am AccessAssist');
    await sendIntent(worker, { id: 'stop-intro', mode: 'typing', source: 'command', tabId: 0, at: Date.now() });
    await expect(panel.locator('#message')).toBeFocused();
    await panel.close();

    const reopened = await openFirstUsePanel(context, extensionId);
    await expect(reopened.locator('#page-line')).toBeVisible();
    await expect.poll(() => announcements(reopened)).toContain('hear the introduction again');
    const heard = await announcements(reopened);
    expect(heard).not.toContain('Hi, I am AccessAssist');
    expect(heard).toContain('hear the introduction again');
    const stored = await worker.evaluate(
      async () => chrome.storage.local.get(['introSeen', 'introCompleted']),
    );
    expect(stored.introSeen).toBe(true);
    expect('introCompleted' in stored).toBe(false);
  } finally {
    await context.close();
  }
});

test('replaying the introduction keeps the draft and does not request the microphone', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    expect((await voiceState(panel)).starts).toBe(0);

    await panel.locator('#message').fill('half written');
    await expect(panel.locator('#mode-line')).toContainText('input: typing');
    const before = await voiceState(panel);
    await sendIntent(worker, { id: 'replay', mode: 'intro', source: 'command', tabId: 0, at: Date.now() });
    await expect.poll(async () => await announcements(panel)).toContain('Hi, I am AccessAssist');

    const after = await voiceState(panel);
    expect(after.gumCalls).toBe(before.gumCalls);
    expect(after.installCalls.length).toBe(before.installCalls.length);
    expect(after.starts).toBe(before.starts);
    expect(after.active).toBe(false);
    expect(await panel.locator('#message').inputValue()).toBe('half written');
    await expect(panel.locator('#mode-line')).toContainText('input: typing');
    expect(await announcements(panel)).not.toContain('Current page:');
  } finally {
    await context.close();
  }
});


test('two panels opening together play the introduction only once', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await openFixture(context, '/article');
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([
      first.goto(`chrome-extension://${extensionId}/sidepanel.html`),
      second.goto(`chrome-extension://${extensionId}/sidepanel.html`),
    ]);
    await Promise.all([
      first.waitForSelector('#voice-setup', { state: 'attached' }),
      second.waitForSelector('#voice-setup', { state: 'attached' }),
    ]);
    await expect.poll(async () => introCount(`${await announcements(first)} ${await announcements(second)}`)).toBe(1);
    await first.waitForTimeout(300);
    expect(introCount(`${await announcements(first)} ${await announcements(second)}`)).toBe(1);
    const stored = await worker.evaluate(
      async () => chrome.storage.local.get(['introSeen', 'introCompleted']),
    );
    expect(stored.introSeen).toBe(true);
    expect('introCompleted' in stored).toBe(false);
  } finally {
    await context.close();
  }
});

test('an older completed marker migrates to the claimed introduction state', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await openFixture(context, '/article');
    await worker.evaluate(() => chrome.storage.local.set({ introCompleted: true }));
    const panel = await openFirstUsePanel(context, extensionId);
    await expect.poll(async () => `${await announcements(panel)}`)
      .toContain('hear the introduction again');
    const heard = `${await announcements(panel)}`;
    expect(heard).not.toContain('Hi, I am AccessAssist');
    const stored = await worker.evaluate(
      async () => chrome.storage.local.get(['introSeen', 'introCompleted']),
    );
    expect(stored.introSeen).toBe(true);
    expect('introCompleted' in stored).toBe(false);
  } finally {
    await context.close();
  }
});


test('replaying the introduction preserves an open choice and draft', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    await panel.locator('#message').fill('draft text');
    const before = await voiceState(panel);
    await sendIntent(worker, { id: 'replay-choice', mode: 'intro', source: 'command', tabId: 0, at: Date.now() });
    await expect.poll(async () => await announcements(panel)).toContain('Hi, I am AccessAssist');
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    await expect(panel.locator('#ask')).toBeVisible();
    expect(await panel.locator('#message').inputValue()).toBe('draft text');
    expect((await voiceState(panel)).gumCalls).toBe(before.gumCalls);
  } finally {
    await context.close();
  }
});
