import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  announcementEntries,
  announcements,
  answer,
  answerWhen,
  launch,
  mockRequests,
  MOCK_BASE,
  openFixture,
  openPanel,
  resetMock,
  sendText,
  undoLastChange,
  voiceState,
} from './helpers.js';

const launcherOpen = (page) => page.locator('#accessassist-launcher-host #launcher-open');

async function waitForLauncher(page) {
  await expect(launcherOpen(page)).toHaveCount(1);
  await expect(page.locator('#accessassist-launcher-host')).toHaveAttribute('data-loaded', 'true');
}

async function launcherState(page) {
  return page.evaluate(() => {
    const host = document.getElementById('accessassist-launcher-host');
    const root = host.shadowRoot;
    const style = getComputedStyle(host);
    const rect = root.querySelector('.launcher-bar').getBoundingClientRect();
    return {
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
      bar: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      active: root.activeElement?.id || root.activeElement?.getAttribute('aria-label') || '',
      status: root.querySelector('[role="status"]').textContent,
    };
  });
}

async function storedLauncher(worker) {
  return worker.evaluate(async () => (await chrome.storage.local.get('launcherPosition')).launcherPosition);
}

async function sessionIntents(worker) {
  return worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null))
    .filter((key) => key.startsWith('intent:')));
}

async function clearIntents(worker) {
  await worker.evaluate(async () => {
    const keys = Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith('intent:'));
    if (keys.length) await chrome.storage.session.remove(keys);
  });
}

async function watchIntentEvents(worker) {
  await worker.evaluate(() => {
    globalThis.__aaIntentEvents = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('intent:')) globalThis.__aaIntentEvents.push(change.newValue ? 'set' : 'clear');
      }
    });
  });
}

async function intentEvents(worker) {
  return worker.evaluate(() => globalThis.__aaIntentEvents ?? []);
}

async function dragLauncher(page, { dx, dy, escape = false, release = true } = {}) {
  const box = await launcherOpen(page).boundingBox();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  if (escape) await page.keyboard.press('Escape');
  if (release) await page.mouse.up();
  return { startX, startY };
}

async function dragLauncherTo(page, x, y) {
  const box = await launcherOpen(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

test('read flow speaks the real paragraph and does not submit the form', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph: meet at the community center on Friday at 3 p.m. Bring water.', { timeout: 30_000 });
    await expect(page.locator('#submits')).toHaveText('0');

    const requests = await mockRequests();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.model).toBe('deepseek-v4.1-flash');
      expect(request.authorization).toBe('Bearer [redacted]');
      expect(request.apiKeyPresent).toBe(false);
    }
  } finally {
    await context.close();
  }
});

test('debug log export records the session without the API key', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { apiKey: 'sk-debug-secret-42' });
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph: meet at the community center on Friday at 3 p.m. Bring water.', { timeout: 30_000 });

    await panel.locator('#settings-toggle').click();
    const [download] = await Promise.all([
      panel.waitForEvent('download'),
      panel.locator('#export-log').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^accessassist-debug-.+\.json$/u);
    const text = fs.readFileSync(await download.path(), 'utf8');
    expect(text).not.toContain('sk-debug-secret-42');

    const report = JSON.parse(text);
    expect(report.format).toBe('accessassist-debug-log/1');
    expect(report.requestTimeoutMs).toBe(180_000);
    expect(report.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'turn.start',
      'model.request',
      'model.response',
      'tool.call',
      'tool.result',
      'worker.request',
      'worker.response',
      'speech.status',
      'choice.show',
      'choice.finish',
      'voice.result',
    ]));
    expect(report.events.find((event) => event.kind === 'turn.start').data.text)
      .toBe('What is this page about? Read the second paragraph.');
  } finally {
    await context.close();
  }
});

test('a cold panel loads hidden from screen readers, then names Listen first', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    // A reader auto-reads a freshly loaded document and keeps reading whatever
    // is exposed while it reads, so at load only the live region is exposed and
    // nothing in the panel holds focus.
    await context.addInitScript(() => {
      if (location.protocol !== 'chrome-extension:') return;
      const hidden = (id) => Boolean(document.getElementById(id).closest('[aria-hidden="true"]'));
      const snapshot = () => ({
        stage: document.body.dataset.quiet ?? null,
        active: document.activeElement?.id || document.activeElement?.tagName || null,
        listenHidden: hidden('listen'),
        restHidden: hidden('settings-toggle') && hidden('transcript') && hidden('pause'),
        statusHidden: hidden('sr-status'),
      });
      addEventListener('load', () => {
        window.__aaAtLoad = {
          ...snapshot(),
          quiet: document.querySelectorAll('[data-quiet-load][aria-hidden="true"]').length,
        };
      });
      addEventListener('DOMContentLoaded', () => {
        window.__aaStages = [];
        new MutationObserver(() => window.__aaStages.push(snapshot()))
          .observe(document.body, { attributes: true, attributeFilter: ['data-quiet'] });
      });
    });
    const panel = await openPanel(context, extensionId);
    await expect.poll(() => panel.evaluate(() => window.__aaAtLoad ?? null)).toEqual({
      stage: 'all', active: 'BODY', listenHidden: true, restHidden: true, statusHidden: false, quiet: 8,
    });
    // With no entry, Listen alone is exposed and focused; with no input at all,
    // the rest appears shortly after.
    await panel.locator('body[data-revealed="true"]').waitFor({ state: 'attached' });
    expect(await panel.evaluate(() => window.__aaStages)).toEqual([
      { stage: 'listen', active: 'listen', listenHidden: false, restHidden: true, statusHidden: false },
      { stage: 'none', active: 'listen', listenHidden: false, restHidden: false, statusHidden: false },
    ]);
    expect(await panel.locator('[data-quiet-load], [aria-hidden="true"]:is(header, .panel-content, #composer button, #actions-heading)').count())
      .toBe(0);
    await expect(panel.locator('#listen')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('a real option click returns focus to Listen, not the document', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });

    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#ask-question')).toContainText('AM or PM', { timeout: 30_000 });
    await expect(panel.locator('#listen')).toBeFocused();
    expect(await panel.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expect.poll(async () => await announcements(panel)).toContain('Selected option 1:');
    expect((await voiceState(panel)).starts).toBe(1);
  } finally {
    await context.close();
  }
});

test('choice completion returns to a stable trigger outside the question', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#close-panel').focus();
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#close-panel')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('an unusable saved trigger falls back to Listen', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#close-panel').focus();
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await panel.evaluate(() => { document.getElementById('close-panel').disabled = true; });
    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#listen')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('completion behind another page does not pull focus into the panel', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await panel.locator('#ask-options button').first().focus();
    await page.bringToFront();
    await panel.evaluate(() => {
      window.__aaWindowFocus = 0;
      window.focus = () => { window.__aaWindowFocus += 1; };
    });
    await answer(panel, 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM', { timeout: 30_000 });
    expect(await panel.evaluate(() => window.__aaWindowFocus)).toBe(0);
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  } finally {
    await context.close();
  }
});

test('programmatic completion leaves unrelated settings focus alone', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#settings-toggle').click();
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await panel.locator('#api-key').focus();
    await answer(panel, 0);
    await expect(panel.locator('#api-key')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('ambiguous time asks for AM or PM, then edits with confirmation and undo', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Native time grid');

    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');

    await answerWhen(panel, 'AM or PM', 1);

    const slot = (day, time) => page.locator(`input[aria-label="${day} ${time}"]`);
    for (const time of ['14:00', '14:15', '14:30', '14:45']) {
      await expect(slot('Monday', time)).toBeChecked();
    }
    await expect(slot('Monday', '13:45')).toBeChecked();
    await expect(slot('Monday', '15:00')).not.toBeChecked();
    await expect(slot('Tuesday', '14:00')).not.toBeChecked();

    await expect(panel.locator('#transcript')).toContainText('Selected Monday 2 PM to 3 PM.');
    await expect.poll(async () => (await announcements(panel)).includes('Confirming.')).toBe(true);
    const spoken = await announcements(panel);
    expect(spoken).not.toContain('Let me check');
    expect(spoken).not.toContain('could not confirm');
    expect(spoken).not.toContain('Keep these changes?');
    await expect(panel.locator('#transcript')).not.toContainText('Let me check');

    // The action ran without a question and the model saw the page it produced:
    // one observation, one short target id, and the checked slot.
    const requests = await mockRequests();
    const messages = requests.at(-1).body.messages;
    const proposeResult = JSON.parse(messages.filter((message) => message.role === 'tool').at(-1).content);
    const slotTarget = proposeResult.page.targets.find((target) => target.name === 'Monday 14:00');
    expect(slotTarget.checked).toBe(true);
    expect(slotTarget.id).toMatch(/^[0-9a-f]{8}-\d+$/u);
    expect(slotTarget).not.toHaveProperty('snapshotId');
    const observations = messages
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.function.name === 'observe_page');
    expect(observations).toHaveLength(1);
    expect(spoken).toContain('Doing: Select Monday from 2 PM to 3 PM.');
    expect(spoken).not.toContain('Run this?');
  } finally {
    await context.close();
  }
});

test('bare digits stay native while the master combination chooses', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    const question = await panel.locator('#ask-question').textContent();

    // A bare digit on a choice button is not an assistant shortcut.
    await panel.locator('#ask-options button').first().focus();
    await panel.keyboard.press('1');
    await panel.waitForTimeout(150);
    await expect(panel.locator('#ask')).toBeVisible();
    await expect(panel.locator('#ask-question')).toHaveText(question);

    // An unavailable number is not consumed and changes nothing.
    await panel.keyboard.press('Control+Shift+9');
    await panel.waitForTimeout(150);
    await expect(panel.locator('#ask')).toBeVisible();
    await expect(panel.locator('#ask-question')).toHaveText(question);

    // The page itself has no numbered listener, even for the same combination.
    await page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true, bubbles: true,
      }));
    });
    await panel.waitForTimeout(150);
    await expect(panel.locator('#ask')).toBeVisible();
    await expect(panel.locator('#ask-question')).toHaveText(question);

    // Shift turns the key label into a symbol; the physical digit still works
    // and the undoable selection runs without a confirmation question.
    await panel.keyboard.press('Control+Shift+2');
    await expect(page.locator('input[aria-label="Monday 14:00"]')).toBeChecked();
  } finally {
    await context.close();
  }
});

test('a stale choice button does not answer the new question', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/frame-overlay');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Click the same-origin button.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('Run this?');
    await panel.evaluate(() => {
      window.__staleChoice = document.querySelector('#ask-options button');
    });
    await answer(panel, 0);
    await expect(panel.locator('#ask-question')).toContainText('Run anyway?');
    await panel.evaluate(() => window.__staleChoice.click());
    await panel.waitForTimeout(200);
    await expect(panel.locator('#ask-question')).toContainText('Run anyway?');
    await expect(page.locator('#frame-clicks')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('undo restores the original native checkbox set', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'AM or PM', 1);
    await undoLastChange(panel);
    await answerWhen(panel, 'Undo this change?', 0);

    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);
    const checked = await page.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.checked)
      .map((input) => input.getAttribute('aria-label')));
    expect(checked).toEqual(['Monday 13:45']);
  } finally {
    await context.close();
  }
});

test('custom grid needs real mouse input and undo asks again', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-custom');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Custom time grid');

    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'AM or PM', 1);
    await undoLastChange(panel);

    const states = () => page.evaluate(() => [...document.querySelectorAll('[role="gridcell"]')]
      .filter((cell) => cell.getAttribute('aria-checked') === 'true')
      .map((cell) => cell.getAttribute('aria-label')));
    await expect.poll(async () => (await states()).length).toBe(5);

    await answerWhen(panel, 'Undo this change?', 0);
    await expect.poll(states).toEqual(['Monday 13:45']);
    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);
  } finally {
    await context.close();
  }
});

test('undo restores the previously chosen radio', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/choices');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Choice fixture radio.');
    await answerWhen(panel, 'page text', 0);
    await undoLastChange(panel);
    await answerWhen(panel, 'Undo this change?', 0);

    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);
    const checked = await page.evaluate(() => [...document.querySelectorAll('input[name="plan"]')]
      .filter((input) => input.checked)
      .map((input) => input.getAttribute('aria-label')));
    expect(checked).toEqual(['Basic plan']);
  } finally {
    await context.close();
  }
});

test('an already-checked custom checkbox is not toggled', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/choices');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Plan choices');
    await sendText(panel, 'Choice fixture checkbox.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Done with the choice.', { timeout: 30_000 });
    await expect(page.locator('#toggles')).toHaveText('0');
    await expect(page.locator('#updates')).toHaveAttribute('aria-checked', 'true');
  } finally {
    await context.close();
  }
});

test('a parent overlay over an iframe blocks the click', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/frame-overlay');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Frame overlay');
    await sendText(panel, 'Click the same-origin button.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);

    await expect.poll(async () => announcements(panel), { timeout: 30_000 }).toContain('covered');
    await expect(page.locator('#frame-clicks')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('a synthetic launcher click does not open the assistant', async () => {
  const { context, worker } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    await waitForLauncher(page);
    await clearIntents(worker);
    await watchIntentEvents(worker);

    await page.evaluate(() => {
      document.getElementById('accessassist-launcher-host').shadowRoot.querySelector('#launcher-open').click();
    });
    await page.waitForTimeout(200);
    await launcherOpen(page).click();
    const sets = async () => (await intentEvents(worker)).filter((event) => event === 'set');
    await expect.poll(sets, { timeout: 5_000 }).toHaveLength(1);
    await page.waitForTimeout(500);
    expect(await sets()).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('form edit is verified and undo stops on a later user change', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Change the name to Alex Morgan.');
    await answerWhen(panel, 'page text', 0);
    await expect(page.locator('#name')).toHaveValue('Alex Morgan');

    await page.locator('#name').fill('Jordan Lee');
    await panel.evaluate(() => document.getElementById('undo').click());
    await expect.poll(async () => (await announcements(panel)).includes('Undo stopped')).toBe(true);
    await expect(page.locator('#name')).toHaveValue('Jordan Lee');
  } finally {
    await context.close();
  }
});

test('an action starts only when the turn can still confirm it', async () => {
  const { context, extensionId } = await launch();
  try {
    for (const { at, runs } of [{ at: 14, runs: true }, { at: 15, runs: false }]) {
      await resetMock();
      const page = await openFixture(context, '/article');
      const panel = await openPanel(context, extensionId);
      await sendText(panel, `Late name change at ${at}: Alex Morgan.`);
      await answerWhen(panel, 'page text', 0);
      await expect(panel.locator('#transcript'))
        .toContainText(runs ? 'Done: the name is Alex Morgan.' : 'too few model calls left', { timeout: 30_000 });
      await expect(panel.locator('#transcript')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      const spoken = await announcements(panel);
      expect(spoken).not.toContain('model calls. Give a new instruction.');
      expect(spoken.includes('Doing:')).toBe(runs);
      expect(spoken.includes('Confirming.')).toBe(runs);
      if (runs) await expect(page.locator('#name')).toHaveValue('Alex Morgan');
      else await expect(page.locator('#name')).not.toHaveValue('Alex Morgan');
      await panel.close();
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test('submit needs two confirmations and reports that undo is unavailable', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Submit the form.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);
    await expect(page.locator('#submits')).toHaveText('1');
    await expect.poll(async () => (await announcements(panel)).includes('cannot be undone')).toBe(true);
    await expect(page.locator('#submits')).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('authentication failure is spoken and focuses the key form', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { baseUrl: 'http://127.0.0.1:4174/deny/v1' });
    await sendText(panel, 'What is this page about?');
    await expect.poll(async () => (await announcements(panel)).includes('The key was rejected')).toBe(true);
    await expect(panel.locator('#settings')).toBeVisible();
    await expect(panel.locator('#api-key')).toBeFocused();
    expect(await page.title()).toBe('Event schedule');
    const requests = await mockRequests();
    expect(requests.length).toBe(0);
  } finally {
    await context.close();
  }
});

test('image choice cancels without upload and AI choice sends a cropped screenshot', async () => {
  const { context, extensionId } = await launch();
  // Windows, through both inputs detection reads, so the reader is asked and
  // the offered readers are known.
  await context.addInitScript(() => {
    if (!location.protocol.startsWith('chrome-extension:')) return;
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Win32' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => ({ platform: 'Windows', mobile: false, brands: [] }),
    });
  });
  const guideEntries = (panel) => panel.locator('.message-body', { hasText: 'Here are the NVDA keys' }).count();
  try {
    await resetMock();
    const page = await openFixture(context, '/images');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Image test');

    await sendText(panel, 'What is this image?');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'How should I describe this image?', 2);
    await expect(panel.locator('#transcript')).toContainText('did not read the image');
    let requests = await mockRequests();
    expect(requests.some((request) => JSON.stringify(request.body).includes('image_url'))).toBe(false);
    expect(await page.locator('#noalt').getAttribute('alt')).toBeNull();

    await page.bringToFront();
    await sendText(panel, 'What is this image?');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'How should I describe this image?', 1);
    // Detection can only tell Windows from macOS, so on Windows the reader
    // itself is asked, offering the three Windows readers.
    await expect(panel.locator('#ask-question')).toContainText('Which screen reader');
    expect(await panel.locator('#ask-options button').allTextContents())
      .toEqual(['1 Narrator', '2 NVDA', '3 JAWS', '4 Back']);
    await panel.locator('#ask-options button', { hasText: 'NVDA' }).click();
    await expect(panel.locator('#transcript')).toContainText('NVDA plus R');
    expect(await guideEntries(panel)).toBe(1);
    expect(await announcements(panel)).not.toContain('Continue?');
    await expect(panel.locator('#transcript')).toContainText('screen-reader guide');
    requests = await mockRequests();
    expect(requests.some((request) => JSON.stringify(request.body).includes('image_url'))).toBe(false);
    expect(await panel.locator('#screen-reader').inputValue()).toBe('nvda');

    await page.bringToFront();
    await sendText(panel, 'What is this image?');
    await answerWhen(panel, 'Allow these sources', 1);
    // The stored answer means the reader is asked once, not once per image:
    // the guide follows the describe choice directly. Wait for that second
    // guide, so a picker opened late would still be caught below.
    const guidesBefore = await guideEntries(panel);
    await answerWhen(panel, 'How should I describe this image?', 1);
    await expect.poll(() => guideEntries(panel), { timeout: 30_000 }).toBe(guidesBefore + 1);
    await expect(panel.locator('#ask')).toBeHidden();
    expect(await announcements(panel)).not.toContain('Continue?');
    await expect(panel.locator('#transcript')).toContainText('screen-reader guide');
    requests = await mockRequests();
    expect(requests.some((request) => JSON.stringify(request.body).includes('image_url'))).toBe(false);
  } finally {
    await context.close();
  }
});

test('regression: a framed page is refused for AI image reading without pixels', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/images');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Image test');
    await sendText(panel, 'What is this image?');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'How should I describe this image?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'screenshot', 0);
    const refusal = 'Screenshot unavailable: this page has embedded or sensitive areas that cannot be safely frozen.';
    await expect.poll(async () => JSON.stringify(await mockRequests()), { timeout: 30_000 }).toContain(refusal);
    const requests = JSON.stringify(await mockRequests());
    expect(requests).not.toContain('image_url');
    expect(await page.locator('#noalt').getAttribute('alt')).toBeNull();
  } finally {
    await context.close();
  }
});

test('same-origin iframe clicks use mapped coordinates', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/images');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Click the same-origin button.');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);
    await expect(page.locator('#frame-clicks')).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('duplicate same-origin frames keep their own document identity', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/frame-duplicate');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Click the second frame button.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(page.locator('#clicks-two')).toHaveText('1');
    await expect(page.locator('#clicks-one')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('cross-origin iframe only loads after consent and clicks correctly', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/images');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Click the cross-origin button.');
    await answerWhen(panel, 'Allow these sources', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);
    await expect(page.locator('#frame-clicks')).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('AI image description restores the original missing alt attribute', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/image-simple');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Add a description to the image.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'How should I describe this image?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'screenshot', 0);
    await expect.poll(async () => (await mockRequests()).some((request) => JSON.stringify(request.body).includes('image_url'))).toBe(true);
    const withImage = (await mockRequests()).find((request) => JSON.stringify(request.body).includes('image_url'));
    expect(withImage).toBeTruthy();
    await expect(page.locator('#simple')).toHaveAttribute('alt', 'A red circle to the left of a blue square, with EXIT below.');

    await panel.evaluate(() => document.getElementById('undo').click());
    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);
    await expect(page.locator('#simple')).not.toHaveAttribute('alt');
  } finally {
    await context.close();
  }
});

test('one source list authorizes current frames and later lists only new sites', async () => {
  const { context, extensionId } = await launch();
  const addFrames = async (page, from, to, sameOrigin = false) => {
    await page.evaluate(async ({ first, last, duplicate }) => {
      const waits = [];
      const add = (src) => {
        const frame = document.createElement('iframe');
        frame.width = '160';
        frame.height = '50';
        const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
        frame.src = src;
        waits.push(loaded);
        document.body.append(frame);
      };
      for (let index = first; index <= last; index += 1) {
        add(`https://third-party-source-${String(index).padStart(2, '0')}.example.test/frame`);
      }
      if (duplicate) add('/frame');
      await Promise.all(waits);
    }, { first: from, last: to, duplicate: sameOrigin });
  };
  try {
    await resetMock();
    await context.route('https://third-party-source-*.example.test/**', async (route) => {
      const host = new URL(route.request().url()).hostname;
      const number = host.match(/third-party-source-(\d+)/u)?.[1] ?? '00';
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<html lang="en"><body><p>THIRD-PARTY-MARKER-${number}</p></body></html>`,
      });
    });
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await addFrames(page, 1, 12, true);

    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    const sites = panel.locator('#ask-sites li');
    await expect(sites).toHaveCount(13);
    expect(await sites.first().locator('span[aria-hidden="true"]').textContent())
      .toBe('http://127.0.0.1:4173');
    const listed = await panel.locator('#ask-sites').textContent();
    expect(listed.length).toBeGreaterThan(500);
    expect(listed).toContain('https://third-party-source-12.example.test');
    expect(listed.match(/https:\/\/third-party-source-/gu)).toHaveLength(12);
    const beforeRequests = (await mockRequests()).length;

    const metadata = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const article = tabs.find((tab) => tab.url?.includes('/article'));
      const info = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO', tabId: article.id });
      return chrome.runtime.sendMessage({
        type: 'GET_PAGE_ORIGINS',
        tabId: article.id,
        expectedDocumentId: info.documentId,
      });
    });
    expect(metadata.origin).toBe('http://127.0.0.1:4173');
    expect(metadata.frameOrigins).toEqual(Array.from({ length: 12 }, (_, index) => (
      `https://third-party-source-${String(index + 1).padStart(2, '0')}.example.test`
    )));
    expect((await mockRequests()).length).toBe(beforeRequests);

    const crossFrames = page.frames().filter((frame) => frame.url().includes('third-party-source-'));
    expect(crossFrames).toHaveLength(12);
    expect(JSON.stringify(await mockRequests())).not.toContain('THIRD-PARTY-MARKER');

    // A frame added while the choice is open is not part of this snapshot;
    // Repeat must still read the original source list.
    await addFrames(page, 13, 13);
    const announcementsBefore = await announcements(panel);
    await panel.locator('#repeat').click();
    await expect.poll(async () => (await announcements(panel)).length).toBeGreaterThan(announcementsBefore.length);
    expect(await announcements(panel)).toContain('Sites included:');
    expect(await announcements(panel)).toContain('third-party-source-12.example.test');
    expect(await announcements(panel)).not.toContain('https://third-party-source-');
    expect(await announcements(panel)).not.toContain('Source site');
    expect(await announcements(panel)).not.toContain('third-party-source-13.example.test');
    // The visible list keeps the canonical origins used for authorization.
    await expect(panel.locator('#ask-sites li').last().locator('span[aria-hidden="true"]'))
      .toHaveText('https://third-party-source-12.example.test');

    await answerWhen(panel, 'Allow these sources', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph');
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(beforeRequests);
    const allowedRequests = JSON.stringify(await mockRequests());
    for (let index = 1; index <= 12; index += 1) {
      expect(allowedRequests).toContain(`THIRD-PARTY-MARKER-${String(index).padStart(2, '0')}`);
    }
    expect(allowedRequests).not.toContain('THIRD-PARTY-MARKER-13');

    // With only the approved frames present, a new turn reuses the grants.
    await page.evaluate(() => {
      document.querySelector('iframe[src*="third-party-source-13"]')?.remove();
    });
    const settled = (await mockRequests()).length;
    await sendText(panel, 'What is this page about?');
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(settled);
    await expect(panel.locator('#ask')).toBeHidden();

    // A newly inserted frame needs its own small list and stays unread when
    // skipped; skips are per turn, not a permanent grant.
    await addFrames(page, 13, 13);
    const beforeNew = (await mockRequests()).length;
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await expect(panel.locator('#ask-sites li')).toHaveCount(1);
    await expect(panel.locator('#ask-sites li').locator('span[aria-hidden="true"]'))
      .toHaveText('https://third-party-source-13.example.test');
    await answerWhen(panel, 'Allow these sources', 1);
    await expect.poll(async () => (await mockRequests()).length, { timeout: 10_000 }).toBeGreaterThan(beforeNew);
    const finalRequest = JSON.stringify((await mockRequests()).at(-1).body);
    expect(finalRequest).not.toContain('THIRD-PARTY-MARKER-13');
    expect(finalRequest).toContain('THIRD-PARTY-MARKER-12');
  } finally {
    await context.close();
  }
});

test('HTTPS www receiver and source are spoken as domains without changing origin identity', async () => {
  const { context, extensionId } = await launch();
  const origin = 'https://www.opencode.ai';
  const modelUrls = [];
  try {
    await resetMock();
    await context.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const target = new URL(request.url());
      if (target.pathname === '/article') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><title>Domain test</title></head>
            <body><main><p>Domain page text.</p><img id="pic" src="${origin}/shape.svg"></main></body></html>`,
        });
      }
      if (target.pathname === '/untitled') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><title>${origin}/untitled</title></head>
            <body><p>Untitled page.</p></body></html>`,
        });
      }
      if (target.pathname === '/shape.svg') {
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15" fill="red"/></svg>',
        });
      }
      if (target.pathname.startsWith('/v1/')) {
        modelUrls.push(request.url());
        const response = await route.fetch({
          url: `${MOCK_BASE}${target.pathname}${target.search}`,
          method: request.method(),
          headers: request.headers(),
          ...(request.postDataBuffer() ? { postData: request.postDataBuffer() } : {}),
        });
        return route.fulfill({ response });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });

    const page = await context.newPage();
    await page.goto(`${origin}/article`);
    await page.waitForFunction(() => document.getElementById('pic')?.complete);
    await page.bringToFront();
    const panel = await openPanel(context, extensionId, {
      baseUrl: `${origin}/v1`,
    });

    await sendText(panel, 'What is in this image?');
    await expect(panel.locator('#ask-question')).toContainText('Reading page text from the listed sites');
    await expect.poll(async () => await announcements(panel)).toContain('sends it to opencode.ai');
    const consent = await announcements(panel);
    expect(consent).toContain('Sites included: opencode.ai');
    expect(consent).not.toContain('https://www.opencode.ai');
    await expect(panel.locator('#ask-sites li').first().locator('span[aria-hidden="true"]'))
      .toHaveText(origin);
    await expect(panel.locator('#ask-sites li').first().locator('span.visually-hidden'))
      .toHaveText('opencode.ai');
    const identity = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes('/article'));
      const info = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO', tabId: tab.id });
      return { info, stored: await chrome.storage.local.get('apiConfig') };
    });
    expect(identity.info.origin).toBe(origin);
    expect(identity.info.url).toBe(`${origin}/article`);
    expect(identity.stored.apiConfig.baseUrl).toBe(`${origin}/v1`);

    await answerWhen(panel, 'Allow these sources', 0);
    await answerWhen(panel, 'How should I describe this image?', 0);
    await expect(panel.locator('#ask-question')).toContainText('The receiver is opencode.ai');
    await expect(panel.locator('#ask-sites')).toBeHidden();
    const receiverEntries = async () => (await announcementEntries(panel))
      .filter((entry) => entry.includes('The receiver is opencode.ai')).length;
    // The question's own first reading must land before the baseline, or it
    // alone would satisfy the check below even if Repeat did nothing.
    await expect.poll(receiverEntries).toBe(1);
    const beforeRepeat = (await announcementEntries(panel)).length;
    await panel.locator('#repeat').click();
    await expect.poll(receiverEntries).toBe(2);
    // Let the repeated reading's hold run out. The queue writes its next
    // message in the same step that clears the region, so an empty region
    // means nothing queued behind the repeat is still unwritten.
    await expect(panel.locator('#sr-status')).toHaveText('');
    const repeated = (await announcementEntries(panel)).slice(beforeRepeat).join(' ');
    expect(repeated).not.toContain('https://www');
    // The previous question was answered before this one appeared; its reading
    // must not surface afterwards.
    expect(repeated).not.toContain('How should I describe this image?');
    // Cleared after its hold, so the hidden region never becomes a second,
    // stale copy of the transcript in the accessibility tree.
    await expect(panel.locator('#sr-status')).toHaveText('');

    // Screenshot capture needs the page tab active; clicking the panel through
    // Playwright does not bring the panel tab to the front.
    await page.bringToFront();
    await answerWhen(panel, 'The receiver is opencode.ai', 0);
    await expect(panel.locator('#transcript')).toContainText('The image shows', { timeout: 30_000 });
    expect(JSON.stringify(await mockRequests())).toContain('image_url');
    expect(modelUrls).toContain(`${origin}/v1/chat/completions`);
    expect(modelUrls.every((url) => url.startsWith(`${origin}/v1/`))).toBe(true);

    // A URL-shaped page title is also spoken as a domain on a tab switch.
    const beforeSwitch = (await announcementEntries(panel)).length;
    const other = await context.newPage();
    await other.goto(`${origin}/untitled`);
    // newPage activates before navigation; switch away and back so the
    // activation event carries the loaded URL.
    await page.bringToFront();
    await other.bringToFront();
    await expect.poll(async () => (await announcementEntries(panel)).length)
      .toBeGreaterThan(beforeSwitch);
    const switched = (await announcementEntries(panel)).slice(beforeSwitch).join(' ');
    expect(switched).toContain('Current page: opencode.ai');
    expect(switched).not.toContain('https://');
  } finally {
    await context.close();
  }
});

test('the reader hears every choice before the source list', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-sites')).toBeVisible();
    await expect.poll(async () => await announcements(panel)).toContain('Allow these sources');
    const heard = await announcements(panel);
    expect(heard).toContain('Choice 1. Allow');
    expect(heard).toContain('Choice 2. Cancel');
    expect(heard.indexOf('Choice 1. Allow')).toBeLessThan(heard.indexOf('Sites included:'));
    expect(heard).toContain('Sites included: http://127.0.0.1:4173.');
  } finally {
    await context.close();
  }
});

test('shadow DOM content is observed and offered to the model', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/shadow');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'What is in the shadow DOM?');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Shadow heading', { timeout: 30_000 });
    expect(await page.evaluate(() => Boolean(document.getElementById('host').shadowRoot))).toBe(true);
  } finally {
    await context.close();
  }
});

test('reasoning effort saves without clearing the key and reaches each protocol', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    let panel = await openPanel(context, extensionId);
    const keyBefore = await panel.evaluate(() => chrome.storage.session.get('apiKey'));
    expect(keyBefore.apiKey.value).toBe('test-key');

    const openAdvanced = async () => {
      if (await panel.locator('#settings').isHidden()) {
        await panel.locator('#settings-toggle').click();
      }
      if (!(await panel.locator('#advanced-api').evaluate((details) => details.open))) {
        await panel.locator('#advanced-api > summary').click();
      }
    };

    await openAdvanced();
    await panel.locator('#effort').selectOption('high');
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    expect((await panel.evaluate(() => chrome.storage.local.get('apiConfig'))).apiConfig.effort).toBe('high');
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore.apiKey);

    await panel.close();
    panel = await openPanel(context, extensionId, { seed: false });
    await expect(panel.locator('#effort')).toHaveValue('high');
    let count = (await mockRequests()).length;
    await sendText(panel, 'What is this page about?');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Event schedule', { timeout: 30_000 });
    await expect.poll(async () => (await mockRequests()).length).toBeGreaterThan(count);
    let requests = (await mockRequests()).slice(count);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.path === '/v1/chat/completions')).toBe(true);
    expect(requests.every((request) => request.body.reasoning_effort === 'high')).toBe(true);
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore.apiKey);

    await openAdvanced();
    await panel.locator('#protocol').selectOption('anthropic');
    await panel.locator('#effort').selectOption('max');
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    expect(await panel.evaluate(async () => (await chrome.storage.local.get('apiConfig')).apiConfig))
      .toMatchObject({ protocol: 'anthropic', effort: 'max' });
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore.apiKey);
    count = (await mockRequests()).length;
    await sendText(panel, 'What does the second paragraph say?');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph', { timeout: 30_000 });
    await expect.poll(async () => (await mockRequests()).length).toBeGreaterThan(count);
    requests = (await mockRequests()).slice(count);
    expect(requests.every((request) => request.path === '/v1/messages')).toBe(true);
    expect(requests.every((request) => request.body.output_config?.effort === 'max')).toBe(true);
    expect(requests.every((request) => request.body.reasoning_effort === undefined)).toBe(true);

    await openAdvanced();
    await panel.locator('#protocol').selectOption('openai');
    await panel.locator('#effort').selectOption('default');
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    expect((await panel.evaluate(() => chrome.storage.session.get('apiKey'))).apiKey).toEqual(keyBefore.apiKey);
    count = (await mockRequests()).length;
    await sendText(panel, 'What is this page about?');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Event schedule', { timeout: 30_000 });
    await expect.poll(async () => (await mockRequests()).length).toBeGreaterThan(count);
    requests = (await mockRequests()).slice(count);
    expect(requests.every((request) => request.body.reasoning_effort === undefined)).toBe(true);
    expect(requests.every((request) => request.body.output_config === undefined)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a reader-only save is announced and leaves the running turn alone', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask-question')).toContainText('page text');
    const requestsBefore = (await mockRequests()).length;

    await panel.locator('#settings-toggle').click();
    await panel.locator('#screen-reader').selectOption('nvda');
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    await expect.poll(() => announcementEntries(panel)).toContain('Settings saved.');
    expect(await panel.evaluate(async () => (await chrome.storage.local.get('screenReader')).screenReader))
      .toBe('nvda');

    // Nothing reached the model, so the open question and its turn continue.
    expect((await mockRequests()).length).toBe(requestsBefore);
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Event schedule', { timeout: 30_000 });
    await expect(panel.locator('#transcript')).toContainText('What is this page about?');
  } finally {
    await context.close();
  }
});

test('the Assistant launcher drags, persists, and never opens the panel', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    await waitForLauncher(page);
    const initial = await launcherState(page);
    expect(initial.bar.x + initial.bar.width).toBeLessThanOrEqual(initial.viewport.width);
    expect(initial.bar.y + initial.bar.height).toBeLessThanOrEqual(initial.viewport.height);
    expect(await storedLauncher(worker)).toEqual({ x: 1, y: 1 });
    const pagesBefore = context.pages().length;
    await worker.evaluate(() => {
      globalThis.__launcherPositionWrites = 0;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.launcherPosition) {
          globalThis.__launcherPositionWrites = (globalThis.__launcherPositionWrites ?? 0) + 1;
        }
      });
    });

    const box = await launcherOpen(page).boundingBox();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 260, startY - 180, { steps: 8 });
    const during = await launcherState(page);
    expect(during.left).toBeLessThan(initial.left);
    expect(await storedLauncher(worker)).toEqual({ x: 1, y: 1 });
    await page.mouse.up();
    await expect.poll(async () => (await launcherState(page)).status).toContain('saved');
    const saved = await storedLauncher(worker);
    expect(saved).not.toBe('br');
    expect(saved.x).toBeGreaterThan(0);
    expect(saved.x).toBeLessThan(1);
    expect(saved.y).toBeGreaterThan(0);
    expect(saved.y).toBeLessThan(1);
    await expect.poll(() => sessionIntents(worker)).toEqual([]);
    expect(context.pages().length).toBe(pagesBefore);
    await expect.poll(() => worker.evaluate(() => globalThis.__launcherPositionWrites)).toBe(1);

    const expectedLeft = (state) => 16 + saved.x * Math.max(0, state.viewport.width - state.bar.width - 32);
    const expectedTop = (state) => 16 + saved.y * Math.max(0, state.viewport.height - state.bar.height - 32);
    const placed = await launcherState(page);
    expect(Math.abs(placed.left - expectedLeft(placed))).toBeLessThan(1.5);
    expect(Math.abs(placed.top - expectedTop(placed))).toBeLessThan(1.5);

    await page.setViewportSize({ width: 391, height: 904 });
    await expect.poll(async () => {
      const state = await launcherState(page);
      return state.viewport.width === 391 ? Math.abs(state.left - expectedLeft(state)) : Infinity;
    }).toBeLessThan(1.5);
    const narrowPlaced = await launcherState(page);
    expect(Math.abs(narrowPlaced.left - expectedLeft(narrowPlaced))).toBeLessThan(1.5);
    expect(Math.abs(narrowPlaced.top - expectedTop(narrowPlaced))).toBeLessThan(1.5);
    expect(narrowPlaced.bar.x + narrowPlaced.bar.width).toBeLessThanOrEqual(391 + 1);
    expect(await storedLauncher(worker)).toEqual(saved);
    await page.setViewportSize({ width: 1000, height: 760 });
    await expect.poll(async () => {
      const state = await launcherState(page);
      return state.viewport.width === 1000 ? Math.abs(state.left - expectedLeft(state)) : Infinity;
    }).toBeLessThan(1.5);
    expect(await storedLauncher(worker)).toEqual(saved);

    await page.reload();
    await waitForLauncher(page);
    const reloaded = await launcherState(page);
    expect(Math.abs(reloaded.left - expectedLeft(reloaded))).toBeLessThan(1.5);
    expect(Math.abs(reloaded.top - expectedTop(reloaded))).toBeLessThan(1.5);

    const other = await openFixture(context, '/untitled');
    await waitForLauncher(other);
    const otherState = await launcherState(other);
    expect(Math.abs(otherState.left - expectedLeft(otherState))).toBeLessThan(1.5);
    expect(Math.abs(otherState.top - expectedTop(otherState))).toBeLessThan(1.5);

    const panel = await openPanel(context, extensionId);
    expect(await storedLauncher(worker)).toEqual(saved);
    await panel.close();
    await page.bringToFront();

    await dragLauncherTo(page, 1, 1);
    await expect.poll(async () => (await storedLauncher(worker)).x).toBe(0);
    expect((await storedLauncher(worker)).y).toBe(0);
    const topLeft = await launcherState(page);
    expect(topLeft.bar.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.bar.y).toBeGreaterThanOrEqual(0);

    await dragLauncherTo(page, 999, 759);
    await expect.poll(async () => (await storedLauncher(worker)).x).toBe(1);
    expect((await storedLauncher(worker)).y).toBe(1);
    const bottomRight = await launcherState(page);
    expect(bottomRight.bar.x + bottomRight.bar.width).toBeLessThanOrEqual(bottomRight.viewport.width + 1);
    expect(bottomRight.bar.y + bottomRight.bar.height).toBeLessThanOrEqual(bottomRight.viewport.height + 1);
    expect(await sessionIntents(worker)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('launcher drag cannot click through; Shift+Arrow moves it, and focus returns to the open button', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    await waitForLauncher(page);
    let savedStart = await storedLauncher(worker);

    const box = await launcherOpen(page).boundingBox();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await watchIntentEvents(worker);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 2, startY + 1);
    await page.mouse.up();
    await expect.poll(() => intentEvents(worker)).toContain('set');
    await clearIntents(worker);
    expect(await storedLauncher(worker)).toEqual(savedStart);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 120, startY - 80, { steps: 6 });
    await page.mouse.move(startX, startY, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => sessionIntents(worker)).toEqual([]);
    const returned = await launcherState(page);
    expect(Math.abs(returned.bar.x - box.x)).toBeLessThan(1.5);
    expect(Math.abs(returned.bar.y - box.y)).toBeLessThan(1.5);

    const beforeEscape = await launcherState(page);
    await dragLauncher(page, { dx: -140, dy: -100, escape: true });
    expect(await storedLauncher(worker)).toEqual(savedStart);
    const escaped = await launcherState(page);
    expect(Math.abs(escaped.left - beforeEscape.left)).toBeLessThan(1);
    expect(escaped.status).toContain('cancelled');

    const cdp = await context.newCDPSession(page);
    const touchBox = await launcherOpen(page).boundingBox();
    const touchX = touchBox.x + touchBox.width / 2;
    const touchY = touchBox.y + touchBox.height / 2;
    const touchBefore = await storedLauncher(worker);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: touchX, y: touchY, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: touchX - 90, y: touchY - 70, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => storedLauncher(worker)).not.toEqual(touchBefore);
    savedStart = await storedLauncher(worker);
    expect(await sessionIntents(worker)).toEqual([]);

    const touchSaved = await storedLauncher(worker);
    const cancelBox = await launcherOpen(page).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cancelBox.x + cancelBox.width / 2, y: cancelBox.y + cancelBox.height / 2, id: 2 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cancelBox.x + cancelBox.width / 2 + 80, y: cancelBox.y + cancelBox.height / 2 + 50, id: 2 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await storedLauncher(worker)).toEqual(touchSaved);
    const canceledTouch = await launcherState(page);
    expect(Math.abs(canceledTouch.bar.x - cancelBox.x)).toBeLessThan(1.5);
    expect(Math.abs(canceledTouch.bar.y - cancelBox.y)).toBeLessThan(1.5);

    await page.evaluate(() => {
      const open = document.getElementById('accessassist-launcher-host').shadowRoot.querySelector('#launcher-open');
      const rect = open.getBoundingClientRect();
      const base = {
        bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: rect.left + 20, clientY: rect.top + 20,
      };
      open.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1 }));
      open.dispatchEvent(new PointerEvent('pointermove', { ...base, button: -1, buttons: 1, clientX: rect.left - 100 }));
      open.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0, clientX: rect.left - 100 }));
    });
    expect(await storedLauncher(worker)).toEqual(savedStart);

    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((candidate) => candidate.url?.includes('/article')).id;
    });
    await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'FOCUS_LAUNCHER' }), tabId);
    await expect.poll(async () => (await launcherState(page)).active).toBe('launcher-open');
    const keyStart = await storedLauncher(worker);
    await page.evaluate(() => {
      window.__aaPageKeys = [];
      window.addEventListener('keydown', (event) => window.__aaPageKeys.push(event.key));
    });
    const beforeKey = await launcherState(page);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(async () => (await storedLauncher(worker)).x).toBeLessThan(keyStart.x);
    const afterKey = await launcherState(page);
    expect(beforeKey.left - afterKey.left).toBeGreaterThan(15);
    expect(afterKey.active).toBe('launcher-open');
    expect(await page.evaluate(() => window.__aaPageKeys)).not.toContain('ArrowLeft');
    expect(await sessionIntents(worker)).toEqual([]);
    await clearIntents(worker);
    await watchIntentEvents(worker);
    await page.keyboard.press('Enter');
    await expect.poll(() => intentEvents(worker)).toContain('set');
  } finally {
    await context.close();
  }
});

test('launcher broadcasts its position and hides from page observation', async ({}, testInfo) => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const other = await openFixture(context, '/untitled');
    await waitForLauncher(page);
    await waitForLauncher(other);
    const panel = await openPanel(context, extensionId);

    await other.bringToFront();
    await dragLauncher(other, { dx: -200, dy: -150 });
    await expect.poll(async () => (await storedLauncher(worker)).x).toBeLessThan(1);
    const saved = await storedLauncher(worker);
    expect(saved.x).toBeLessThan(1);
    expect(saved.y).toBeLessThan(1);

    await page.bringToFront();
    await expect.poll(async () => (await launcherState(page)).left).toBeCloseTo(16 + saved.x * (
      (await launcherState(page)).viewport.width - (await launcherState(page)).bar.width - 32
    ), 0);

    const beforeBroadcast = await storedLauncher(worker);
    const otherTabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((candidate) => candidate.url?.includes('/untitled')).id;
    });
    const broadcast = { x: 0.15, y: 0.25 };
    await worker.evaluate(async ({ tabId, position }) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (next) => chrome.runtime.sendMessage({ type: 'SET_LAUNCHER_POSITION', position: next }),
        args: [position],
      });
    }, { tabId: otherTabId, position: broadcast });
    await expect.poll(() => storedLauncher(worker)).toEqual(broadcast);
    expect(await storedLauncher(worker)).not.toEqual(beforeBroadcast);

    const observation = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes('/article'));
      const info = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO', tabId: tab.id });
      return chrome.runtime.sendMessage({
        type: 'OBSERVE_PAGE',
        tabId: tab.id,
        expectedDocumentId: info.documentId,
        visual: true,
      });
    });
    expect(observation.visual?.allowed).toBe(true);
    expect(observation.visual?.dataUrl).toMatch(/^data:image\/png;base64,/u);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain('Open the AccessAssist assistant');
    const observationPng = Buffer.from(observation.visual.dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(testInfo.outputPath('launcher-observation.png'), observationPng);
    await testInfo.attach('launcher-observation', {
      path: testInfo.outputPath('launcher-observation.png'),
      contentType: 'image/png',
    });
    await expect(launcherOpen(page)).toBeVisible();
    expect((await launcherState(page)).bar.width).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});


test('composer number keys prepare, pause, repeat, cancel, and open settings', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    expect((await voiceState(panel)).starts).toBe(0);

    await panel.locator('#listen').focus();
    await expect(panel.locator('#listen')).toHaveText('1 Prepare voice');
    await panel.keyboard.press('Control+Shift+1');
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('Voice ready.');
    expect((await voiceState(panel)).starts).toBe(0);

    await panel.locator('#pause').focus();
    await panel.keyboard.press('Control+Shift+2');
    await expect.poll(async () => await announcements(panel)).toContain('Paused.');
    await expect.poll(async () => (await voiceState(panel)).active).toBe(false);

    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await expect(panel.locator('#ask-question')).toContainText('page text', { timeout: 15_000 });

    const beforeRepeat = await announcements(panel);
    await panel.locator('#repeat').focus();
    await panel.keyboard.press('Control+Shift+3');
    await expect.poll(async () => (await announcements(panel)).length).toBeGreaterThan(beforeRepeat.length);
    await expect(panel.locator('#ask-question')).toContainText('page text');

    await panel.locator('#cancel').focus();
    await panel.keyboard.press('Control+Shift+4');
    await expect(panel.locator('#ask')).toBeHidden();

    await expect(panel.locator('#settings')).toBeHidden();
    await panel.locator('#listen').focus();
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toBeVisible();
    // Focus stays on Listen; 8 from the composer closes it again.
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toBeHidden();

    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toBeVisible();
    await panel.locator('#api-key').focus();
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toBeHidden();
    await expect(panel.locator('#settings-toggle')).toBeFocused();
  } finally {
    await context.close();
  }
});

test('settings number keys save, expand, replay, and follow links', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#listen').focus();
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toBeVisible();

    await panel.locator('#save-settings').focus();
    await panel.keyboard.press('Control+Shift+3');
    await expect(panel.locator('#advanced-api')).toHaveJSProperty('open', true);

    // Native select type-ahead keeps its own digits.
    await panel.locator('#protocol').focus();
    await panel.keyboard.press('2');
    await expect(panel.locator('#protocol')).toHaveValue('anthropic');
    await expect(panel.locator('#anthropic-version')).toBeVisible();

    await panel.locator('#api-key').fill('number-key');
    await panel.locator('#save-settings').focus();
    await panel.keyboard.press('Control+Shift+4');
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    const stored = await panel.evaluate(() => chrome.storage.session.get('apiKey'));
    expect(stored.apiKey.value).toBe('number-key');

    await expect(panel.locator('#settings')).toBeVisible();
    await panel.locator('#replay-intro').focus();
    await panel.keyboard.press('Control+Shift+5');
    await expect.poll(async () => await announcements(panel)).toContain('Hi, I am AccessAssist');

    await context.route('https://opencode.ai/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>docs</title>ok',
    }));
    const consolePopup = context.waitForEvent('page');
    await panel.locator('#save-settings').focus();
    await panel.keyboard.press('Control+Shift+1');
    const consolePage = await consolePopup;
    await consolePage.waitForLoadState('domcontentloaded');
    expect(consolePage.url()).toBe('https://opencode.ai/console');
    await consolePage.close();

    const helpPopup = context.waitForEvent('page');
    await panel.locator('#save-settings').focus();
    await panel.keyboard.press('Control+Shift+2');
    const helpPage = await helpPopup;
    await helpPage.waitForLoadState('domcontentloaded');
    expect(helpPage.url()).toBe('https://opencode.ai/docs/go/');
    await helpPage.close();
    expect(await panel.evaluate(() => document.getElementById('api-key').value)).toBe('');
  } finally {
    await context.close();
  }
});

test('numbered undo restores the original native checkbox set', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'AM or PM', 1);
    await expect(page.locator('input[aria-label="Monday 14:00"]')).toBeChecked();

    await panel.locator('#undo').focus();
    await panel.keyboard.press('Control+Shift+5');
    await expect(panel.locator('#ask-question')).toContainText('Undo this change?');
    // Screen-reader mode keeps the user's focus so the announcement is not cut
    // off; the first number still answers the open question.
    await expect(panel.locator('#ask-options button').first()).not.toBeFocused();
    expect(await panel.evaluate(() => document.activeElement?.id)).toBe('undo');
    await panel.keyboard.press('Control+Shift+1');
    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);
    const checked = await page.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.checked)
      .map((input) => input.getAttribute('aria-label')));
    expect(checked).toEqual(['Monday 13:45']);
  } finally {
    await context.close();
  }
});

test('Close panel uses native close, keeps settings, and reports a failure in place', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    const windowId = await panel.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    await panel.evaluate(() => {
      window.__closeCalls = [];
      chrome.sidePanel.close = async (options) => {
        window.__closeCalls.push(options);
        throw new Error('not a native side panel');
      };
    });

    // The old numeric alias is gone: a plain 7 and the master combination
    // without a matching control do nothing.
    expect(await panel.locator('#close-panel').getAttribute('data-number')).toBeNull();
    await panel.locator('#close-panel').focus();
    await panel.keyboard.press('Control+Shift+7');
    await panel.waitForTimeout(150);
    expect(await panel.evaluate(() => window.__closeCalls.length)).toBe(0);

    await panel.locator('#close-panel').click();
    await expect.poll(async () => await panel.evaluate(() => window.__closeCalls.length)).toBe(1);
    expect(await panel.evaluate(() => window.__closeCalls[0])).toEqual({ windowId });
    await expect.poll(async () => await announcements(panel))
      .toContain('Could not close the assistant. not a native side panel');
    // A failed native close leaves both documents intact.
    await expect(panel.locator('#page-line')).toContainText('Event schedule');
    expect(page.isClosed()).toBe(false);
    await expect(panel.locator('#ask')).toBeHidden();

    const stored = await panel.evaluate(async () => ({
      key: (await chrome.storage.session.get('apiKey')).apiKey,
      mode: (await chrome.storage.local.get('outputMode')).outputMode,
    }));
    expect(stored.key?.value).toBe('test-key');
    expect(stored.mode).toBeUndefined();
  } finally {
    await context.close();
  }
});

test('a background close notification performs cleanup without closing natively', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    const windowId = await panel.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    await panel.evaluate(() => {
      window.__closeCalls = [];
      chrome.sidePanel.close = async (options) => { window.__closeCalls.push(options); };
    });
    await sendText(panel, 'What is this page about?');
    await expect(panel.locator('#ask')).toBeVisible();

    // Wrong-window and page-sender messages are ignored in both directions.
    await worker.evaluate((id) => chrome.runtime.sendMessage({ type: 'CLOSE_PANEL', windowId: id + 99 }), windowId);
    await worker.evaluate((id) => chrome.runtime.sendMessage({
      type: 'PANEL_CLOSE_ERROR',
      windowId: id + 99,
      error: 'wrong window',
    }), windowId);
    await panel.waitForTimeout(150);
    await expect(panel.locator('#ask')).toBeVisible();
    expect(await announcements(panel)).not.toContain('wrong window');

    await worker.evaluate(async (id) => {
      const page = (await chrome.tabs.query({})).find((tab) => /^https?:/u.test(tab.url ?? ''));
      await chrome.scripting.executeScript({
        target: { tabId: page.id },
        func: (target) => chrome.runtime.sendMessage({ type: 'CLOSE_PANEL', windowId: target }).catch(() => {}),
        args: [id],
      });
    }, windowId);
    await panel.waitForTimeout(150);
    await expect(panel.locator('#ask')).toBeVisible();

    // The worker notification releases panel-local work; the background owns
    // the native close and expects no reply.
    const response = await worker.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'CLOSE_PANEL', windowId: id }).catch(() => null),
      windowId,
    );
    expect(response).toBeUndefined();
    await expect(panel.locator('#ask')).toBeHidden();
    expect(await panel.evaluate(() => window.__closeCalls.length)).toBe(0);

    await worker.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'PANEL_CLOSE_ERROR', windowId: id, error: 'native close failed' }),
      windowId,
    );
    await expect.poll(async () => await announcements(panel))
      .toContain('Could not close the assistant. native close failed');
    expect(await panel.evaluate(() => window.__closeCalls.length)).toBe(0);
  } finally {
    await context.close();
  }
});

test('a page that never answers reset or focus does not block the native close', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    const windowId = await panel.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    await panel.evaluate(() => {
      window.__closeCalls = [];
      chrome.sidePanel.close = async (options) => { window.__closeCalls.push(options); };
      // Model page/worker messages that never settle; neither may gate close.
      chrome.runtime.sendMessage = () => new Promise(() => {});
      chrome.tabs.sendMessage = () => new Promise(() => {});
    });

    await panel.locator('#close-panel').click();
    await expect.poll(async () => await panel.evaluate(() => window.__closeCalls.length)).toBe(1);
    expect(await panel.evaluate(() => window.__closeCalls[0])).toEqual({ windowId });
  } finally {
    await context.close();
  }
});

test('changing the API origin clears the old key', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.evaluate(() => {
      document.getElementById('settings-toggle').click();
      document.getElementById('api-key').value = 'old-form-key';
      document.getElementById('base-url').value = 'http://127.0.0.1:4175/v1';
      document.getElementById('settings-form').requestSubmit();
    });
    await expect(panel.locator('#settings-status')).toContainText('Saved');
    await expect.poll(async () => (await announcements(panel)).includes('old key was cleared')).toBe(true);
    await expect(panel.locator('#api-key')).toBeFocused();
    await expect(panel.locator('#api-key')).toHaveValue('');
    const stored = await panel.evaluate(() => chrome.storage.session.get('apiKey'));
    expect(stored.apiKey).toBeUndefined();
    expect(await page.title()).toBe('Event schedule');
  } finally {
    await context.close();
  }
});

test('Anthropic format also edits and undoes a grid', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'AM or PM', 1);
    await undoLastChange(panel);
    await answerWhen(panel, 'Undo this change?', 0);
    await expect.poll(async () => (await announcements(panel)).includes('Undone')).toBe(true);

    const checked = await page.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.checked)
      .map((input) => input.getAttribute('aria-label')));
    expect(checked).toEqual(['Monday 13:45']);
    const requests = await mockRequests();
    const last = [...requests].reverse().find((entry) => entry.path === '/v1/messages');
    expect(JSON.stringify(last.body)).toContain('tool_use');
    expect(JSON.stringify(last.body)).toContain('tool_result');
  } finally {
    await context.close();
  }
});

test('Anthropic format reads through Messages with tool_result blocks', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'What is this page about? Read the second paragraph.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Second paragraph: meet at the community center on Friday at 3 p.m. Bring water.', { timeout: 30_000 });
    const requests = await mockRequests();
    const request = [...requests].reverse().find((entry) => entry.path === '/v1/messages');
    expect(request).toBeTruthy();
    expect(request.apiKeyPresent).toBe(true);
    expect(request.authorization).toBeNull();
    expect(typeof request.body.system).toBe('string');
    expect(request.body.tools[0].input_schema.type).toBe('object');
    expect(JSON.stringify(request.body.messages)).toContain('tool_result');
    expect(await page.locator('#submits').textContent()).toBe('0');
  } finally {
    await context.close();
  }
});

test('pointer-only day cells are clicked by center coordinates', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-pointer');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Pointer time grid');

    await sendText(panel, 'Select Monday and Wednesday at 2 PM in the pointer grid.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Selected Monday and Wednesday at 2 PM.', { timeout: 30_000 });
    await expect(page.locator('#Day-1-2')).toHaveClass(/selected/u);
    await expect(page.locator('#Day-3-2')).toHaveClass(/selected/u);
    await expect(page.locator('#Day-2-2')).not.toHaveClass(/selected/u);
    await expect(page.locator('#commits')).toHaveText('2');
  } finally {
    await context.close();
  }
});

test('weekday cells in a layout table are selected and verified', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/days-legacy');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('When is everyone free');
    const urlBefore = page.url();

    await sendText(panel, 'Switch Survey using to Days of the Week. Select Monday and Wednesday only. Leave the event name, times, and all other fields unchanged. Do not create or submit an event.');
    await answerWhen(panel, 'page text', 0);

    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Selected Monday and Wednesday.', { timeout: 30_000 });
    const oracle = await page.evaluate(() => ({
      mode: document.getElementById('DateTypes').value,
      dates: document.getElementById('PossibleDates').value,
      days: [...document.querySelectorAll('input[id^="DateOf-6-"]')].map((input) => input.value),
      name: document.getElementById('EventName').value,
      zone: document.getElementById('TimeZone').value,
      commits: Number(document.getElementById('commits').textContent),
      submits: window.__submitted ?? 0,
      url: location.href,
    }));
    expect(oracle.mode).toBe('DaysOfTheWeek');
    expect(oracle.dates).toBe('1,3');
    expect(oracle.days).toEqual(['1', '', '3', '', '', '', '']);
    expect(oracle.name).toBe('Weekly planning');
    expect(oracle.zone).toBe('Europe/London');
    expect(oracle.commits).toBe(2);
    expect(oracle.submits).toBe(0);
    expect(oracle.url).toBe(urlBefore);

    const received = JSON.stringify(await mockRequests());
    expect(received).not.toContain('PossibleDates');
    expect(received).not.toContain('DateOf-6-');
    expect(received).not.toContain('"type":"image_url"');
  } finally {
    await context.close();
  }
});

test('a constrained key press toggles a custom control', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/keyboard');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Keyboard control');

    await sendText(panel, 'Use the keyboard: press Enter on the Toggle.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Pressed Enter on the toggle.', { timeout: 30_000 });
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toggle')).toHaveText('On');
  } finally {
    await context.close();
  }
});

test('markdown markup is stripped from the visible and spoken reply', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    await sendText(panel, 'Show the markdown.');
    await expect(panel.locator('#transcript')).toContainText('Monday and Wednesday are available.', { timeout: 30_000 });
    const text = await panel.locator('#transcript').textContent();
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
    expect(text).toContain('Use Start talking to continue.');
    expect(await page.locator('#submits').textContent()).toBe('0');
  } finally {
    await context.close();
  }
});

test('a screenshot click needs image consent and hits the canvas control', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/visual');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Visual control');
    await page.bringToFront();

    await sendText(panel, 'Click the canvas control from the screenshot.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Clicked the visible control.', { timeout: 30_000 });
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(state, JSON.stringify(state)).toMatchObject({ painted: '1' });
  } finally {
    await context.close();
  }
});

test('a visual drag uses the latest screenshot coordinates', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/visual');
    const panel = await openPanel(context, extensionId);
    await page.bringToFront();
    await sendText(panel, 'Run the visual drag case.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Dragged across the canvas.', { timeout: 30_000 });
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(state, JSON.stringify(state)).toMatchObject({ dragged: '1' });
  } finally {
    await context.close();
  }
});

test('a target that moves during confirmation is not clicked', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday and Wednesday at 2 PM in the pointer grid.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.evaluate(() => {
      document.getElementById('Day-1-2').style.marginLeft = '60px';
    });
    await answerWhen(panel, 'Run anyway?', 0);

    await expect.poll(async () => await announcements(panel)).toContain('Page state changed');
    await expect(page.locator('#commits')).toHaveText('0');
    expect(await page.locator('#Day-1-2').getAttribute('class')).not.toContain('selected');
  } finally {
    await context.close();
  }
});

test('an overlay added during confirmation blocks the click', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday and Wednesday at 2 PM in the pointer grid.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:transparent';
      overlay.id = 'blocking-overlay';
      document.body.append(overlay);
    });
    await answerWhen(panel, 'Run anyway?', 0);

    await expect.poll(async () => await announcements(panel)).toContain('covered');
    await expect(page.locator('#commits')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('scrolling during visual confirmation invalidates the screenshot point', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/visual-tall');
    const panel = await openPanel(context, extensionId);
    await page.locator('#board').scrollIntoViewIfNeeded();
    await page.bringToFront();
    await sendText(panel, 'Click the canvas control in the visual tall case.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.evaluate(() => window.scrollBy(0, -40));
    await answerWhen(panel, 'Run anyway?', 0);

    await expect.poll(async () => await announcements(panel)).toContain('scrolled');
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(state.painted).toBeUndefined();
  } finally {
    await context.close();
  }
});

test('an image rejection falls back to text and keeps working', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/visual');
    const panel = await openPanel(context, extensionId, { baseUrl: `${MOCK_BASE}/reject/v1` });
    await page.bringToFront();
    await sendText(panel, 'Click the canvas control from the screenshot.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);

    await expect.poll(async () => await announcements(panel)).toContain('did not accept the screenshot');
    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);
    await expect(panel.locator('#transcript')).toContainText('Clicked the visible control.', { timeout: 30_000 });

    const requests = await mockRequests();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((entry) => !JSON.stringify(entry.body).includes('"type":"image"'))).toBe(true);
  } finally {
    await context.close();
  }
});


test('cancelling visual consent sends no image and performs no action', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/visual');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Visual control');
    await page.bringToFront();

    await sendText(panel, 'Click the canvas control in the visual cancel case.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 1);

    await expect(panel.locator('#transcript')).toContainText('could not see the canvas', { timeout: 30_000 });
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(state.painted).toBeUndefined();
    const requests = await mockRequests();
    expect(requests.every((entry) => !JSON.stringify(entry.body).includes('"type":"image'))).toBe(true);
  } finally {
    await context.close();
  }
});

test('a scrolled high-DPI page maps screenshot points to the real control', async () => {
  const { context, extensionId } = await launch({ deviceScaleFactor: 2 });
  try {
    await resetMock();
    const page = await openFixture(context, '/visual-tall');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Tall visual control');
    await page.locator('#board').scrollIntoViewIfNeeded();
    await page.bringToFront();

    await sendText(panel, 'Click the canvas control in the visual tall case.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await answerWhen(panel, 'Run this?', 0);
    await page.bringToFront();
    await answerWhen(panel, 'Run anyway?', 0);

    await expect(panel.locator('#transcript')).toContainText('Clicked the visible control.', { timeout: 30_000 });
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(state, JSON.stringify(state)).toMatchObject({ painted: '1' });
    const requests = await mockRequests();
    const imageRequest = requests.find((entry) => entry.body?.messages?.some((message) => (
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
    )));
    expect(imageRequest).toBeTruthy();
    const caption = imageRequest.body.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part.type === 'text' && part.text.startsWith('Screenshot of the visible page'))?.text;
    expect(caption).toContain('1000 by 760 CSS pixels at scale 1');
  } finally {
    await context.close();
  }
});


test('regression: a visual observation refuses embedded and password pages', async () => {
  const { context, extensionId } = await launch();
  const refusal = 'Screenshot unavailable: this page has embedded or sensitive areas that cannot be safely frozen.';
  try {
    await resetMock();
    const page = await openFixture(context, '/masked');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Mask check');
    await page.bringToFront();

    await sendText(panel, 'Run the mask check.');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'screenshot', 0);
    await expect(panel.locator('#transcript')).toContainText('Saw the masked screen', { timeout: 30_000 });

    let requests = JSON.stringify(await mockRequests());
    expect(requests).toContain(refusal);
    expect(requests).not.toContain('image_url');

    // A frame-free page with a hidden shadow-root password is refused too.
    await resetMock();
    await page.goto('http://127.0.0.1:4173/password');
    await page.bringToFront();
    await expect(panel.locator('#page-line')).toContainText('Password check');
    await sendText(panel, 'Run the mask check.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await expect.poll(async () => JSON.stringify(await mockRequests()), { timeout: 30_000 }).toContain(refusal);
    requests = JSON.stringify(await mockRequests());
    expect(requests).not.toContain('image_url');
    expect(await page.locator('#visible-secret').inputValue()).toBe('hunter2');
  } finally {
    await context.close();
  }
});
