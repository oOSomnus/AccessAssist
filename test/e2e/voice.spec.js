import { expect, test } from '@playwright/test';
import {
  answer,
  answerWhen,
  announcements,
  emitFinal,
  emitNoSpeech,
  endCue,
  holdSpeech,
  launch,
  mockRequests,
  notifyIntent,
  openFirstUsePanel,
  openFixture,
  openPanel,
  releaseEnd,
  releaseSpeech,
  resetMock,
  seedIntent,
  sendIntent,
  sendText,
  setPermission,
  spoken,
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
    expect(await spoken(panel)).not.toContain('Paste your OpenCode Go API key');

    // The numbered Prepare button may install and prompt, but still must not
    // open the microphone.
    await panel.locator('#listen').focus();
    await panel.keyboard.press('2');
    await expect.poll(async () => (await voiceState(panel)).installCalls.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => await spoken(panel), { timeout: 15_000 })
      .toContain('Paste your OpenCode Go API key');
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('Listening is spoken before the microphone opens in both output modes', async () => {
  for (const outputMode of ['tts', 'screen-reader']) {
    const { context, extensionId, worker } = await launch({
      voice: { available: 'available', permission: 'granted', gum: 'grant' },
    });
    try {
      await resetMock();
      await openFixture(context, '/article');
      const panel = await openPanel(context, extensionId, { outputMode });
      await expect.poll(async () => (await voiceState(panel)).starts).toBe(0);
      await holdSpeech(panel);
      await sendIntent(worker, intent(`${outputMode}-listen`));

      await expect.poll(async () => await spoken(panel)).toContain('Listening');
      expect((await voiceState(panel)).starts).toBe(0);
      expect((await voiceState(panel)).nativeBusy).toBe(false);

      await releaseSpeech(panel);
      await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
      await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');

      await emitFinal(panel, 'help');
      await expect.poll(async () => `${await spoken(panel)} ${await announcements(panel)}`)
        .toContain('You can ask what this page is about');
      expect((await mockRequests()).length).toBe(0);
    } finally {
      await context.close();
    }
  }
});

test('blocked Web Audio still speaks Listening and opens the microphone', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', audioRunning: false },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('blocked-audio'));
    await expect.poll(async () => await spoken(panel)).toContain('Listening');
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    expect((await voiceState(panel)).tones).toEqual([]);
    await expect(panel.locator('#mode-line')).toContainText('The start sound is unavailable.');
  } finally {
    await context.close();
  }
});

test('a real start plays the 880 Hz tone before readiness and ignores early speech', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', autoCue: false },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('start-tone'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await expect.poll(async () => (await voiceState(panel)).tones).toContain(880);
    expect(await panel.locator('#mode-line').textContent()).not.toContain('Listening');

    await emitFinal(panel, 'help');
    await panel.waitForTimeout(100);
    expect(await spoken(panel)).not.toContain('You can ask what this page is about');

    await endCue(panel);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    expect(await panel.locator('#mode-line').textContent()).not.toContain('start sound is unavailable');
    await emitFinal(panel, 'help');
    await expect.poll(async () => await spoken(panel)).toContain('I heard: help');
    await expect.poll(async () => `${await spoken(panel)} ${await announcements(panel)}`)
      .toContain('You can ask what this page is about');
  } finally {
    await context.close();
  }
});

test('results before the native start are ignored', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await holdSpeech(panel);
    await sendIntent(worker, intent('before-start'));
    await expect.poll(async () => await spoken(panel)).toContain('Listening');

    await panel.evaluate(() => {
      window.__aaVoice.emit('help');
      window.__aaVoice.emit('help');
    });
    await panel.waitForTimeout(100);
    expect(await spoken(panel)).not.toContain('You can ask what this page is about');

    await releaseSpeech(panel);
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await panel.evaluate(() => {
      window.__aaVoice.emit('help');
      window.__aaVoice.emit('help');
    });
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
    expect(occurrences(await spoken(panel), 'You can ask what this page is about')).toBe(1);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('recognized speech is read back before any request or choice use', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('readback-command'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await holdSpeech(panel);
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await spoken(panel)).toContain('I heard: What is this page about?');
    expect((await mockRequests()).length).toBe(0);
    expect(await spoken(panel)).not.toContain('working');

    await releaseSpeech(panel);
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBe(1);
    const requests = await mockRequests();
    expect(requests[0].body.messages.some((message) => (
      message.role === 'user' && message.content === 'What is this page about?'
    ))).toBe(true);
    expect(occurrences(await spoken(panel), 'I heard: What is this page about?')).toBe(1);

    await answerWhen(panel, 'Allow these sources', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph');
  } finally {
    await context.close();
  }
});

test('a spoken choice is read back and consumes only the original question', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    const before = (await mockRequests()).length;

    await sendIntent(worker, intent('readback-choice'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await holdSpeech(panel);
    await emitFinal(panel, 'one');
    await expect.poll(async () => await spoken(panel)).toContain('I heard: one');
    await expect(panel.locator('#ask')).toBeVisible();
    expect((await mockRequests()).length).toBe(before);

    await releaseSpeech(panel);
    await expect.poll(async () => await spoken(panel)).toContain('Selected option 1: AM.');
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(before);
    expect(occurrences(await spoken(panel), 'I heard: one')).toBe(1);
    expect(occurrences(await spoken(panel), 'Selected option 1: AM.')).toBe(1);
  } finally {
    await context.close();
  }
});

test('interrupting a readback drops the utterance without reopening the microphone', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('readback-cancel'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await holdSpeech(panel);
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await spoken(panel)).toContain('I heard: What is this page about?');
    const starts = (await voiceState(panel)).starts;

    await panel.locator('#pause').click();
    await panel.waitForTimeout(150);
    expect((await mockRequests()).length).toBe(0);
    expect(await panel.locator('#transcript').textContent()).not.toContain('What is this page about?');
    expect((await voiceState(panel)).starts).toBe(starts);
    await releaseSpeech(panel);
    await panel.waitForTimeout(100);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('a failed readback keeps the spoken input unused and says why', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('readback-fail'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await panel.evaluate(() => { window.__aaVoice.ttsFail = true; });
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await announcements(panel))
      .toContain('Your spoken input was not used because its readback could not finish');
    expect((await mockRequests()).length).toBe(0);
    expect(await panel.locator('#transcript').textContent()).not.toContain('What is this page about?');
  } finally {
    await context.close();
  }
});

test('a no-speech end consumes the authorization instead of restarting', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('no-speech-one'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await emitNoSpeech(panel);
    await expect.poll(async () => await panel.locator('#sr-status').textContent())
      .toContain('Press Alt+Z to listen.');
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(1);

    await sendIntent(worker, intent('no-speech-two'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(2);
    expect((await voiceState(panel)).recognitions).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test('three Alt+Z presses complete three one-shot turns', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    for (let turn = 1; turn <= 3; turn += 1) {
      await sendIntent(worker, intent(`turn-${turn}`));
      await expect.poll(async () => (await voiceState(panel)).starts).toBe(turn);
      await emitFinal(panel, 'help');
      await expect.poll(async () => await announcements(panel)).toContain('You can ask what this page is about');
    }
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(3);
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('a second Alt+Z waits for the delayed native end and one final wins', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', holdEnd: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('held-one'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    await sendIntent(worker, intent('held-two'));
    await panel.waitForTimeout(400);
    // The old native session still holds the microphone.
    expect((await voiceState(panel)).starts).toBe(1);
    await releaseEnd(panel);
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(2);

    await panel.evaluate(() => {
      window.__aaVoice.emit('help');
      window.__aaVoice.emit('help');
    });
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
    expect(occurrences(await spoken(panel), 'You can ask what this page is about')).toBe(1);
  } finally {
    await context.close();
  }
});

test('a released recognizer that loses its end never requires a reload', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', dropEnd: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('lost-end-one'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    await sendIntent(worker, intent('lost-end-two'));
    await expect.poll(async () => (await voiceState(panel)).starts, { timeout: 10_000 }).toBe(2);
    const said = `${await spoken(panel)} ${await announcements(panel)}`;
    expect(said).not.toContain('Reload the panel');
    await emitFinal(panel, 'help');
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
  } finally {
    await context.close();
  }
});

test('a failed native start explains and the next Alt+Z retries', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', failStart: 1, holdEnd: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await panel.locator('#message').fill('draft text');
    await sendIntent(worker, intent('failed-start'));
    await expect.poll(async () => await spoken(panel)).toContain('Chrome could not start speech recognition');
    expect((await voiceState(panel)).starts).toBe(1);
    expect(await panel.locator('#message').inputValue()).toBe('draft text');
    expect(await spoken(panel)).not.toContain('Reload the panel');

    await releaseEnd(panel);
    await sendIntent(worker, intent('retry-start'));
    await expect.poll(async () => (await voiceState(panel)).starts, { timeout: 10_000 }).toBe(2);
    await expect(panel.locator('#mode-line')).toContainText('Listening. Speak now.');
    expect(await panel.locator('#message').inputValue()).toBe('draft text');
  } finally {
    await context.close();
  }
});

test('number 2 prepares voice and keeps an open choice', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    const question = await panel.locator('#ask-question').textContent();
    const starts = (await voiceState(panel)).starts;

    await panel.locator('#listen').focus();
    await panel.keyboard.press('2');
    await expect.poll(async () => await spoken(panel)).toContain('Voice ready. Press Alt+Z to listen.');
    await expect(panel.locator('#ask')).toBeVisible();
    await expect(panel.locator('#ask-question')).toHaveText(question);
    expect((await voiceState(panel)).starts).toBe(starts);
  } finally {
    await context.close();
  }
});

test('duplicate and foreign-window notifications do not restart listening', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    expect((await voiceState(panel)).starts).toBe(0);
    const entry = await sendIntent(worker, intent('same-intent'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    await notifyIntent(worker, entry);
    await notifyIntent(worker, entry);
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(1);

    await sendIntent(worker, intent('other-window', { windowId: 987654 }));
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(1);
  } finally {
    await context.close();
  }
});

test('a persisted command intent is claimed once and not replayed after reload', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const first = await openPanel(context, extensionId, { outputMode: 'tts' });
    await first.close();

    await seedIntent(worker, intent('cold-claim'));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await emitFinal(panel, 'help');
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
    expect((await mockRequests()).length).toBe(0);

    await panel.reload();
    await panel.waitForSelector('#page-line');
    await expect.poll(async () => `${await spoken(panel)} ${await announcements(panel)}`)
      .toContain('hear the introduction again');
    await panel.waitForTimeout(300);
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('unclaimed, expired, and missing-source intents never listen', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    await openPanel(context, extensionId, { outputMode: 'tts' }).then((panel) => panel.close());

    // Seed a voice intent with no source, exactly like an old persisted record.
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => /^https?:/u.test(tab.url ?? ''));
      await chrome.storage.session.set({
        [`intent:${target.windowId}`]: {
          id: 'no-source',
          at: Date.now(),
          mode: 'voice',
          tabId: target.id,
          windowId: target.windowId,
        },
      });
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect.poll(async () => `${await spoken(panel)} ${await announcements(panel)}`)
      .toContain('Press Alt+Z');
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(0);
    await panel.close();

    // An expired command is discarded by the claim itself.
    await page.bringToFront();
    await seedIntent(worker, intent('expired', { at: Date.now() - 61_000 }));
    const late = await openPanel(context, extensionId, { outputMode: 'tts' });
    await late.waitForTimeout(600);
    expect((await voiceState(late)).starts).toBe(0);
    expect(await spoken(late)).not.toContain('Reload the panel');
  } finally {
    await context.close();
  }
});

test('intents are claimed once and stale notices cannot delete a newer one', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const first = await openPanel(context, extensionId, { outputMode: 'tts' });
    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Wait for both cold claims to finish before seeding the race entry.
    await expect.poll(async () => await spoken(first)).toContain('hear the introduction again');
    await expect.poll(async () => await spoken(second)).toContain('hear the introduction again');
    const windowId = await first.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    const claim = (panel, payload) => panel.evaluate(
      (message) => chrome.runtime.sendMessage(message),
      payload,
    );

    await seedIntent(worker, { id: 'race', mode: 'voice', source: 'command', tabId: 0 });
    const results = await Promise.all([
      claim(first, { type: 'CLAIM_INTENT', windowId, intentId: 'race' }),
      claim(second, { type: 'CLAIM_INTENT', windowId, intentId: 'race' }),
    ]);
    expect(results.filter((result) => result.intent).length).toBe(1);

    await seedIntent(worker, { id: 'newer', mode: 'voice', source: 'command', tabId: 0 });
    const stale = await claim(first, { type: 'CLAIM_INTENT', windowId, intentId: 'older' });
    expect(stale.intent).toBeNull();
    const fresh = await claim(first, { type: 'CLAIM_INTENT', windowId, cold: true });
    expect(fresh.intent.id).toBe('newer');
    const again = await claim(first, { type: 'CLAIM_INTENT', windowId, cold: true });
    expect(again.intent).toBeNull();
  } finally {
    await context.close();
  }
});

test('revoking the microphone permission stops the active session', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('revoke-mic'));
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);

    await setPermission(panel, 'denied');
    await expect.poll(async () => (await voiceState(panel)).active).toBe(false);
    await expect(panel.locator('#voice-setup')).toBeVisible();
    await expect(panel.locator('#start-using')).toHaveText('1 Retry');
    await emitFinal(panel, 'help');
    expect(await spoken(panel)).not.toContain('You can ask what this page is about');
  } finally {
    await context.close();
  }
});

test('a browser that refuses local mode explains after Alt+Z without starting', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', localSetterThrows: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('local-refused'));
    await expect.poll(async () => await spoken(panel)).toContain('Local speech recognition is unavailable');
    expect((await voiceState(panel)).starts).toBe(0);
    await expect(panel.locator('#voice-setup')).toBeVisible();
    await expect(panel.locator('#start-using')).toHaveText('1 Retry');
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('hiding and showing the panel does not restart a pending preparation', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', installPending: true, permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await panel.locator('#listen').click();
    await expect.poll(async () => (await voiceState(panel)).gumCalls).toBe(1);
    const before = await voiceState(panel);
    for (let index = 0; index < 4; index += 1) {
      await page.bringToFront();
      await panel.waitForTimeout(60);
      await panel.bringToFront();
      await panel.waitForTimeout(60);
    }
    await panel.waitForTimeout(300);
    const after = await voiceState(panel);
    expect(after.installCalls.length).toBe(before.installCalls.length);
    expect(after.gumCalls).toBe(before.gumCalls);
    expect(after.starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('a refused speech pack install is explained without a false ready', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'downloadable', installAccepted: false, permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await sendIntent(worker, intent('refused-install'));
    await expect.poll(async () => await spoken(panel), { timeout: 15_000 })
      .toContain('English speech pack could not be prepared');
    const state = await voiceState(panel);
    expect(state.starts).toBe(0);
    await expect(panel.locator('#start-using')).toHaveText('1 Retry');
    await expect(panel.locator('#start-using')).toBeVisible();
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('a pending install completes preparation without listening', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', installPending: true, permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await panel.locator('#listen').click();
    await expect.poll(async () => (await voiceState(panel)).gumCalls).toBe(1);

    await panel.evaluate(() => { window.__aaVoice.available = 'available'; });
    await expect.poll(async () => await spoken(panel), { timeout: 10_000 })
      .toContain('Voice ready. Press Alt+Z to listen.');
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('a typing intent aborts preparation and a later Alt+Z listens once', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'downloadable', installPending: true, permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await panel.locator('#listen').click();
    await expect.poll(async () => (await voiceState(panel)).gumCalls).toBe(1);
    const before = await voiceState(panel);

    await sendIntent(worker, { id: 'typing-during', mode: 'typing', source: 'command', tabId: 0 });
    await expect(panel.locator('#message')).toBeFocused();
    await panel.evaluate(() => { window.__aaVoice.available = 'available'; });
    await panel.waitForTimeout(400);
    expect((await voiceState(panel)).starts).toBe(0);

    await sendIntent(worker, intent('voice-after-typing'));
    await expect.poll(async () => (await voiceState(panel)).starts, { timeout: 15_000 }).toBe(1);
    expect((await voiceState(panel)).gumCalls).toBeGreaterThan(before.gumCalls);
  } finally {
    await context.close();
  }
});

test('choosing an option stops the question and speaks the label before continuing', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', ttsHold: true, ttsStopSilent: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    await releaseSpeech(panel);
    await holdSpeech(panel);
    await sendText(panel, 'Select Monday 2 to 3.');
    await expect.poll(async () => await spoken(panel)).toContain('working');
    await releaseSpeech(panel);
    await holdSpeech(panel);
    await expect(panel.locator('#ask-question')).toContainText('page text');

    const before = (await mockRequests()).length;
    await answer(panel, 0);
    await expect.poll(async () => await spoken(panel)).toContain('Selected option 1: Allow.');
    expect((await voiceState(panel)).stopCalls).toBeGreaterThan(0);
    // The tool waits for the feedback; a stopped chunk without events still settles.
    expect((await mockRequests()).length).toBe(before);

    await releaseSpeech(panel);
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(before);
    expect(occurrences(await spoken(panel), 'Selected option 1: Allow.')).toBe(1);
  } finally {
    await context.close();
  }
});

test('Alt+Z during a reply stops the old speech and starts one new command', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    // Hold only the answer reply so the working prompt and consent stay quick.
    let seen = 0;
    let arrived;
    const secondRequest = new Promise((resolve) => { arrived = resolve; });
    let releaseModel;
    const gate = new Promise((resolve) => { releaseModel = resolve; });
    await panel.route('**/v1/chat/completions', async (route) => {
      seen += 1;
      if (seen === 2) {
        arrived();
        await gate;
      }
      await route.continue();
    });

    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await answerWhen(panel, 'page text', 0);
    await secondRequest;
    await holdSpeech(panel);
    releaseModel();
    await expect.poll(async () => occurrences(await spoken(panel), 'Second paragraph')).toBe(1);

    const stops = (await voiceState(panel)).stopCalls;
    await sendIntent(worker, intent('interrupt-reply'));
    await expect.poll(async () => (await voiceState(panel)).stopCalls).toBeGreaterThan(stops);
    expect(await spoken(panel)).not.toContain('Reload the panel');
    await releaseSpeech(panel);
    await expect.poll(async () => (await voiceState(panel)).starts).toBe(1);
    await emitFinal(panel, 'help');
    await expect.poll(async () => await spoken(panel)).toContain('You can ask what this page is about');
    expect(occurrences(await spoken(panel), 'Second paragraph')).toBe(1);
  } finally {
    await context.close();
  }
});

test('assistant text before a tool call is spoken before the question appears', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    let releaseRequest;
    const gate = new Promise((resolve) => { releaseRequest = resolve; });
    let arrive;
    const arrived = new Promise((resolve) => { arrive = resolve; });
    let seen = 0;
    await panel.route('**/v1/chat/completions', async (route) => {
      seen += 1;
      if (seen === 1) {
        arrive();
        await gate;
      }
      await route.continue();
    });

    await holdSpeech(panel);
    await sendText(panel, 'intermediate message test');
    await expect.poll(async () => await spoken(panel)).toContain('working');
    expect((await mockRequests()).length).toBe(0);
    await releaseSpeech(panel);
    await arrived;
    await holdSpeech(panel);
    releaseRequest();

    await expect.poll(async () => await spoken(panel)).toContain('I will ask you one question first.');
    await expect(panel.locator('#ask')).toBeHidden();
    expect((await mockRequests()).length).toBe(1);

    await releaseSpeech(panel);
    await answerWhen(panel, 'Which one?', 0);
    await expect(panel.locator('#transcript')).toContainText('The final answer.');
    expect(occurrences(await spoken(panel), 'I will ask you one question first.')).toBe(1);
    expect(occurrences(await spoken(panel), 'The final answer.')).toBe(1);
  } finally {
    await context.close();
  }
});

test('cancelling an unspeakable tool turn leaves one cancelled result', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    let releaseRequest;
    const gate = new Promise((resolve) => { releaseRequest = resolve; });
    let arrive;
    const arrived = new Promise((resolve) => { arrive = resolve; });
    let seen = 0;
    await panel.route('**/v1/chat/completions', async (route) => {
      seen += 1;
      if (seen === 1) {
        arrive();
        await gate;
      }
      await route.continue();
    });

    await holdSpeech(panel);
    await sendText(panel, 'intermediate message test');
    await releaseSpeech(panel);
    await arrived;
    await holdSpeech(panel);
    releaseRequest();
    await expect.poll(async () => await spoken(panel)).toContain('I will ask you one question first.');

    await panel.locator('#cancel').click();
    await panel.waitForTimeout(200);
    await expect(panel.locator('#ask')).toBeHidden();
    expect((await mockRequests()).length).toBe(1);
    await releaseSpeech(panel);
    expect(await panel.locator('#transcript').textContent()).not.toContain('The final answer.');

    await sendText(panel, 'intermediate message test');
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBe(2);
    const requests = await mockRequests();
    const cancelled = requests[1].body.messages.filter((message) => message.role === 'tool');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].content).toContain('Cancelled before execution because the user interrupted.');
  } finally {
    await context.close();
  }
});

test('screen-reader mode delivers intermediate and final text to the live region', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    await sendText(panel, 'intermediate message test');
    await answerWhen(panel, 'Which one?', 1);
    await expect.poll(async () => await announcements(panel)).toContain('The final answer.');
    const heard = await announcements(panel);
    expect(heard).toContain('I will ask you one question first.');
    expect(await spoken(panel)).not.toContain('I will ask you one question first.');
  } finally {
    await context.close();
  }
});

test('the working word is spoken in screen-reader mode', async () => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    await sendIntent(worker, intent('status-words'));
    await expect.poll(async () => await spoken(panel)).toContain('Listening');
    await emitFinal(panel, 'What is this page about?');
    await expect.poll(async () => await spoken(panel)).toContain('working');
    await expect.poll(async () => await announcements(panel)).toContain('Reading page text from the listed sites');
    // The ordinary reply keeps the selected screen-reader output.
    expect(await spoken(panel)).not.toContain('Reading this page sends page text');
  } finally {
    await context.close();
  }
});

test('the working word is spoken before the model request is sent', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    await holdSpeech(panel);
    await sendText(panel, 'What is this page about?');
    await expect.poll(async () => await spoken(panel)).toContain('working');
    expect((await mockRequests()).length).toBe(0);

    await releaseSpeech(panel);
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('a failed working prompt stops the turn before any work', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant', ttsFail: true },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    await sendText(panel, 'What is this page about?');
    await expect.poll(async () => await announcements(panel))
      .toContain('The working prompt could not be spoken, so this request did not run');
    expect((await mockRequests()).length).toBe(0);
  } finally {
    await context.close();
  }
});

test('one turn speaks working once even when it ends in undo', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId, { outputMode: 'screen-reader' });
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'AM or PM', 1);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 1);
    await answerWhen(panel, 'Undo this change?', 0);
    await expect.poll(async () => await announcements(panel), { timeout: 15_000 }).toContain('Undone');
    expect(occurrences(await spoken(panel), 'working')).toBe(1);

    const heard = await announcements(panel);
    await sendText(panel, 'undo');
    await expect.poll(async () => (await announcements(panel)).length).toBeGreaterThan(heard.length);
    expect(occurrences(await spoken(panel), 'working')).toBe(2);
  } finally {
    await context.close();
  }
});

test('the working tone repeats while the model works and stops at the question', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    let releaseModel;
    const gate = new Promise((resolve) => { releaseModel = resolve; });
    let seen = false;
    await panel.route('**/v1/chat/completions', async (route) => {
      if (!seen) {
        seen = true;
        await gate;
      }
      await route.continue();
    });

    await sendText(panel, 'What is this page about?');
    await expect.poll(async () => await spoken(panel)).toContain('working');
    await panel.waitForTimeout(3600);
    const tones = (await voiceState(panel)).tones;
    expect(tones.length).toBeGreaterThanOrEqual(6);
    expect(tones.every((tone) => tone === 440 || tone === 550)).toBe(true);

    releaseModel();
    await expect.poll(async () => await panel.locator('#ask-question').textContent(), { timeout: 10_000 }).toContain('page text');
    const settled = (await voiceState(panel)).tones.length;
    await panel.waitForTimeout(2000);
    expect((await voiceState(panel)).tones.length).toBe(settled);
  } finally {
    await context.close();
  }
});

test('a new instruction replaces a reply that is still speaking', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    let seen = 0;
    let arrived;
    const secondRequest = new Promise((resolve) => { arrived = resolve; });
    let releaseModel;
    const gate = new Promise((resolve) => { releaseModel = resolve; });
    await panel.route('**/v1/chat/completions', async (route) => {
      seen += 1;
      if (seen === 2) {
        arrived();
        await gate;
      }
      await route.continue();
    });

    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await answerWhen(panel, 'page text', 0);
    await secondRequest;
    await holdSpeech(panel);
    releaseModel();
    await expect.poll(async () => await spoken(panel)).toContain('Second paragraph');

    const before = (await mockRequests()).length;
    const stops = (await voiceState(panel)).stopCalls;
    await sendText(panel, 'What is this page about?');
    // The new working word is held, so no model request starts yet.
    await expect.poll(async () => occurrences(await spoken(panel), 'working')).toBe(2);
    expect((await mockRequests()).length).toBe(before);
    await releaseSpeech(panel);
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(before);
    await expect.poll(async () => occurrences(await spoken(panel), 'Second paragraph'), { timeout: 10_000 }).toBe(2);
    const state = await voiceState(panel);
    expect(state.stopCalls).toBeGreaterThan(stops);
    expect(await spoken(panel)).not.toContain('Working. Please wait.');
  } finally {
    await context.close();
  }
});

test('cancelling uses a falling cue and startup plays none', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'available', permission: 'granted', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { outputMode: 'tts' });
    expect((await voiceState(panel)).tones).toEqual([]);
    await panel.locator('#cancel').click();
    await expect.poll(async () => (await voiceState(panel)).tones.length).toBe(2);
    expect((await voiceState(panel)).tones).toEqual([440, 220]);
  } finally {
    await context.close();
  }
});
