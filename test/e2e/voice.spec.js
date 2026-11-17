import { expect, test } from '@playwright/test';
import {
  announcementEntries,
  announcements,
  answerWhen,
  emitFinal,
  emitNoSpeech,
  emitResults,
  endCue,
  launch,
  mockRequests,
  openFirstUsePanel,
  openFixture,
  openPanel,
  releaseStart,
  resetMock,
  sendIntent,
  sendText,
  setPermission,
  voiceState,
} from './helpers.js';

const occurrences = (text, part) => text.split(part).length - 1;

function intent(id, extra = {}) {
  return { id, mode: 'voice', source: 'command', tabId: 0, ...extra };
}

test('opening the panel installs nothing and starts no microphone', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openFirstUsePanel(context, extensionId);
    await panel.waitForTimeout(400);
    const state = await voiceState(panel);
    expect(state.installCalls).toEqual([]);
    expect(state.gumCalls).toBe(0);
    expect(state.starts).toBe(0);
    expect(await announcements(panel)).not.toContain('Paste your OpenCode Go API key');

    // Numbered preparation may install and prompt, but never opens a command.
    await panel.locator('#listen').focus();
    await panel.keyboard.press('Control+Shift+1');
    await expect.poll(async () => (await voiceState(panel)).installCalls.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => await announcements(panel), { timeout: 15_000 })
      .toContain('Paste your OpenCode Go API key');
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('listening announces only Listening, then one isolated track and a double cue gate readiness', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', autoCue: false },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('prompt-and-cue'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    const started = await voiceState(panel);
    expect(started.gumOptions).toEqual([{ audio: { echoCancellation: { exact: 'all' } } }]);
    expect(started.startTrackKinds).toEqual(['audio']);
    expect(started.lastEcho).toBe('all');
    expect((await announcementEntries(panel)).at(-1)).toBe('Listening.');
    expect((await announcements(panel))).not.toContain('Wait for the tone');

    // The complete double tone gates readiness; the prompt does not.
    await expect.poll(async () => (await voiceState(panel)).tones.filter((tone) => tone === 880).length).toBe(2);
    expect(await panel.locator('#mode-line').textContent()).not.toContain('Listening');
    await endCue(panel);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');

    await emitFinal(panel, 'help');
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('You can ask what this page is about');
    expect((await voiceState(panel)).starts).toBe(1);
    expect((await voiceState(panel)).tracksStopped).toBe(1);
  } finally {
    await context.close();
  }
});

test('a missing announcement target blocks capture before the microphone', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.evaluate(() => document.getElementById('sr-status').remove());
    await sendIntent(worker, intent('prompt-missing'));
    await expect.poll(async () => await announcements(panel))
      .toContain('Listening did not start because its prompt could not be delivered');
    const state = await voiceState(panel);
    expect(state.starts).toBe(0);
    expect(state.gumCalls).toBe(0);
    expect(state.active).toBe(false);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('unavailable audio stops before the microphone instead of listening silently', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', audioRunning: false },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('blocked-audio'));
    await expect.poll(async () => await announcements(panel))
      .toContain('Activate Listen in the panel to enable sound');
    const state = await voiceState(panel);
    expect(state.starts).toBe(0);
    expect(state.gumCalls).toBe(0);
    expect(state.tones).toEqual([]);
    expect(state.active).toBe(false);
  } finally {
    await context.close();
  }
});

test('without system echo cancellation the captured track is refused before recognition', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', echo: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('no-echo-all'));
    await expect.poll(async () => await announcements(panel))
      .toContain('System audio cancellation is unavailable for this recording.');
    const state = await voiceState(panel);
    expect(state.gumCalls).toBe(1);
    expect(state.tracksStopped).toBe(1);
    expect(state.starts).toBe(0);
    expect(state.lastEcho).toBe(true);
  } finally {
    await context.close();
  }
});

test('results and speech before the native start are ignored', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', holdStart: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('before-start'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    await panel.evaluate(() => {
      window.__aaVoice.emit('help');
      window.__aaVoice.emit('help');
    });
    await panel.waitForTimeout(100);
    expect(await announcements(panel)).not.toContain('I heard:');

    await releaseStart(panel);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitResults(panel, [
      { transcript: 'ignored' },
      { transcript: 'help' },
    ]);
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 }).toContain('I heard: help');
    expect(occurrences(await announcements(panel), 'I heard: help')).toBe(1);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('recognized speech is read back before any request or choice use', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('readback-first'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await announcements(panel)).toContain('I heard: What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await answerWhen(panel, 'Allow these sources', 0);
    await expect(panel.locator('#transcript')).toContainText('Event schedule', { timeout: 30_000 });
    expect((await mockRequests()).length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('a one-second pause inside a command still produces one joined instruction', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('joined-phrases'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitResults(panel, [{ transcript: 'What is this page about?' }]);
    await panel.waitForTimeout(1_000);
    await emitResults(panel, [
      { transcript: 'What is this page about?' },
      { transcript: 'Read the second paragraph.' },
    ]);
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('I heard: What is this page about? Read the second paragraph.');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await answerWhen(panel, 'Allow these sources', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph', { timeout: 30_000 });
    expect((await voiceState(panel)).starts).toBe(1);
  } finally {
    await context.close();
  }
});

test('a spoken choice is read back and consumes only the original question', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    const question = await panel.locator('#ask-question').textContent();

    await sendIntent(worker, intent('spoken-one'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(2);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitFinal(panel, 'one');
    await expect.poll(async () => await announcements(panel)).toContain('I heard: one');
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('Selected option 1: AM');
    expect(await panel.locator('#ask-question').textContent()).not.toBe(question);
    expect(occurrences(await announcements(panel), 'I heard: one')).toBe(1);
  } finally {
    await context.close();
  }
});

test('a no-speech timeout consumes one authorization and the next listen starts once', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('no-speech-once'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await expect.poll(async () => await announcements(panel), { timeout: 16_000 })
      .toContain('No speech was heard.');
    expect((await voiceState(panel)).starts).toBe(1);

    await sendIntent(worker, intent('after-no-speech'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(2);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitFinal(panel, 'help');
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('You can ask what this page is about');
  } finally {
    await context.close();
  }
});

test('revoking the microphone permission stops the active session', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('permission-revoked'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await setPermission(panel, 'denied');
    await expect.poll(async () => (await voiceState(panel)).active).toBe(false);
    await expect.poll(async () => await announcements(panel)).toContain('Microphone permission was revoked.');
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('a browser that refuses local mode explains without starting', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', localSetterThrows: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('local-refused'));
    await expect.poll(async () => await announcements(panel))
      .toContain('Local speech recognition is unavailable in this Chrome');
    const state = await voiceState(panel);
    expect(state.starts).toBe(0);
    expect(state.gumCalls).toBe(0);
  } finally {
    await context.close();
  }
});

test('readback and working append to the log and never use the alert channel', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('log-order'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await announcementEntries(panel))
      .toContain('I heard: What is this page about?');
    await expect.poll(async () => await announcementEntries(panel), { timeout: 15_000 })
      .toContain('working');
    const entries = await announcementEntries(panel);
    expect(entries.indexOf('I heard: What is this page about?'))
      .toBeLessThan(entries.indexOf('working'));
    await expect(panel.locator('#sr-alert')).toHaveText('');
  } finally {
    await context.close();
  }
});

test('a spoken answer does not move focus, and the next number answers the new choice', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendIntent(worker, intent('deferred-focus'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    await emitFinal(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await expect(panel.locator('#ask-options button').first()).not.toBeFocused();
    expect(await panel.evaluate(() => document.activeElement?.id)).toBe('listen');
    await panel.keyboard.press('Control+Shift+1');
    await expect(panel.locator('#ask')).toBeHidden();
    expect(occurrences(await announcements(panel), 'Selected option 1: Allow.')).toBe(1);
  } finally {
    await context.close();
  }
});

test('a spoken answer from a focused option restores Listen for the next question', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });

    // Programmatic activation keeps the automatic-question focus deferral in
    // place, while the explicit focus below simulates an open-shortcut target.
    await panel.evaluate(() => document.getElementById('listen').click());
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.', { timeout: 15_000 });
    await panel.locator('#ask-options button').first().focus();
    await emitFinal(panel, '1');
    await expect(panel.locator('#ask-question')).toContainText('AM or PM', { timeout: 30_000 });
    await expect(panel.locator('#listen')).toBeFocused();
    await expect(panel.locator('#ask-options button').first()).not.toBeFocused();
    expect((await voiceState(panel)).starts).toBe(2);
  } finally {
    await context.close();
  }
});

test('one warm open request focuses the choice once', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });

    await panel.evaluate(() => {
      window.__aaFocus = { window: 0, choice: 0 };
      const originalWindowFocus = window.focus.bind(window);
      window.focus = () => {
        window.__aaFocus.window += 1;
        originalWindowFocus();
      };
      const originalFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        if (this.matches?.('#ask-options button')) window.__aaFocus.choice += 1;
        return originalFocus.apply(this, args);
      };
      window.__aaReleaseClaim = null;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message, ...rest) => {
        if (message?.type !== 'CLAIM_INTENT') return send(message, ...rest);
        const response = await send(message, ...rest);
        await new Promise((resolve) => { window.__aaReleaseClaim = resolve; });
        return response;
      };
    });

    await sendIntent(worker, { id: 'held-focus', mode: 'open', source: 'command', tabId: 0 });
    await expect(panel.locator('#ask-options button').first()).toBeFocused();
    expect(await panel.evaluate(() => window.__aaFocus)).toEqual({ window: 1, choice: 1 });

    // While the claim is held, move focus; the post-claim handler retargets the
    // current choice without asking the window for focus again.
    await panel.locator('#ask-options button').nth(1).focus();
    await panel.evaluate(() => window.__aaReleaseClaim?.());
    await expect(panel.locator('#ask-options button').first()).toBeFocused();
    expect(await panel.evaluate(() => window.__aaFocus)).toEqual({ window: 1, choice: 2 });
  } finally {
    await context.close();
  }
});

test('an explicit open shortcut focuses the current choice, else Listen', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await sendIntent(worker, { id: 'focus-choice', mode: 'open', source: 'command', tabId: 0 });
    await expect(panel.locator('#ask-options button').first()).toBeFocused();
    expect((await voiceState(panel)).starts).toBe(1);

    const second = await openPanel(context, extensionId);
    await sendIntent(worker, { id: 'focus-composer', mode: 'open', source: 'command', tabId: 0 });
    await expect(second.locator('#listen')).toBeFocused();
    expect((await voiceState(second)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('an automatic question leaves the user’s focus alone', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#listen').focus();
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    expect(await panel.evaluate(() => document.activeElement?.id)).toBe('listen');
  } finally {
    await context.close();
  }
});

test('a pending install completes preparation without listening', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', permission: 'prompt', gum: 'grant', installPending: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#start-using').click();
    await expect.poll(async () => (await voiceState(panel)).installCalls.length).toBe(1);
    expect((await voiceState(panel)).starts).toBe(0);
    await panel.evaluate(() => { window.__aaVoice.available = 'available'; });
    await expect(panel.locator('#voice-setup')).toBeHidden({ timeout: 20_000 });
    await expect(panel.locator('#listen')).toHaveText('1 Listen');
    expect((await voiceState(panel)).starts).toBe(0);
    await expect(panel.locator('#sr-alert')).toHaveText('');
  } finally {
    await context.close();
  }
});
