import { test, expect } from '@playwright/test';
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
  voiceState,
} from './helpers.js';

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

test('a real option click returns focus to Message, not the document', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });

    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#ask-question')).toContainText('AM or PM', { timeout: 30_000 });
    await expect(panel.locator('#message')).toBeFocused();
    expect(await panel.evaluate(() => document.activeElement === document.body)).toBe(false);
    await panel.keyboard.press('2');
    await expect(panel.locator('#message')).toHaveValue('2');
    await expect.poll(async () => await announcements(panel)).toContain('Selected option 1:');
    expect((await voiceState(panel)).starts).toBe(0);
  } finally {
    await context.close();
  }
});

test('restoring Message after a choice keeps the draft and selection', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await panel.locator('#message').focus();
    await sendText(panel, 'Select Monday two to three.');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });

    await panel.locator('#message').fill('keep this draft');
    await panel.evaluate(() => document.getElementById('message').setSelectionRange(2, 6));
    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#ask-question')).toContainText('AM or PM', { timeout: 30_000 });
    await expect(panel.locator('#message')).toBeFocused();
    expect(await panel.locator('#message').evaluate((element) => ({
      value: element.value,
      start: element.selectionStart,
      end: element.selectionEnd,
    }))).toEqual({ value: 'keep this draft', start: 2, end: 6 });
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

test('an unusable saved trigger falls back to Message', async () => {
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
    await expect(panel.locator('#message')).toBeFocused();
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
    await panel.locator('#settings > summary').click();
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

    // Digits typed in the editor stay text and do not answer the question.
    await panel.locator('#message').focus();
    await panel.locator('#message').press('2');
    await expect(panel.locator('#message')).toHaveValue('2');
    await expect(panel.locator('#ask')).toBeVisible();
    await panel.locator('#message').press('Control+Enter');
    await expect(panel.locator('#message')).toHaveValue('');

    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 0);

    const slot = (day, time) => page.locator(`input[aria-label="${day} ${time}"]`);
    for (const time of ['14:00', '14:15', '14:30', '14:45']) {
      await expect(slot('Monday', time)).toBeChecked();
    }
    await expect(slot('Monday', '13:45')).toBeChecked();
    await expect(slot('Monday', '15:00')).not.toBeChecked();
    await expect(slot('Tuesday', '14:00')).not.toBeChecked();

    await expect(panel.locator('#transcript')).toContainText('Selected Monday 2 PM to 3 PM.');
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

    // The same digit in the message box is ordinary text.
    await panel.locator('#message').press('2');
    await expect(panel.locator('#message')).toHaveValue('2');
    await expect(panel.locator('#ask')).toBeVisible();

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

    // Shift turns the key label into a symbol; the physical digit still works.
    await panel.locator('#message').press('Control+Shift+2');
    await expect(panel.locator('#ask-question')).toContainText('Run this?');
  } finally {
    await context.close();
  }
});

test('a stale choice button does not answer the new question', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/grid-native');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Select Monday two to three.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('AM or PM');
    await panel.evaluate(() => {
      window.__staleChoice = document.querySelector('#ask-options button');
    });
    await answer(panel, 1);
    await expect(panel.locator('#ask-question')).toContainText('Run this?');
    await panel.evaluate(() => window.__staleChoice.click());
    await panel.waitForTimeout(200);
    await expect(panel.locator('#ask-question')).toContainText('Run this?');
    expect(await page.locator('input[aria-label="Monday 14:00"]').isChecked()).toBe(false);
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
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 1);
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
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 1);

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

test('form edit is verified and undo stops on a later user change', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Change the name to Alex Morgan.');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 0);
    await expect(page.locator('#name')).toHaveValue('Alex Morgan');

    await page.locator('#name').fill('Jordan Lee');
    await panel.evaluate(() => document.getElementById('undo').click());
    await expect.poll(async () => (await announcements(panel)).includes('Undo stopped')).toBe(true);
    await expect(page.locator('#name')).toHaveValue('Jordan Lee');
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
    await expect(panel.locator('#settings')).toHaveJSProperty('open', true);
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
    await answerWhen(panel, 'Which system', 0);
    for (let step = 0; step < 5; step += 1) await answerWhen(panel, 'Continue?', 0);
    await expect(panel.locator('#transcript')).toContainText('screen-reader guide');
    requests = await mockRequests();
    expect(requests.some((request) => JSON.stringify(request.body).includes('image_url'))).toBe(false);

    await page.bringToFront();
    await sendText(panel, 'What is this image?');
    await answerWhen(panel, 'Allow these sources', 1);
    await answerWhen(panel, 'How should I describe this image?', 1);
    await answerWhen(panel, 'Which system', 0);
    for (let step = 0; step < 5; step += 1) await answerWhen(panel, 'Continue?', 0);
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
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 0);
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
    const beforeRepeat = (await announcementEntries(panel)).length;
    await panel.locator('#repeat').click();
    await expect.poll(async () => (await announcementEntries(panel)).length).toBeGreaterThan(beforeRepeat);
    const repeated = (await announcementEntries(panel)).slice(beforeRepeat).join(' ');
    expect(repeated).toContain('opencode.ai');
    expect(repeated).not.toContain('https://www');
    await expect(panel.locator('#sr-alert')).toHaveText('');

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

test('launcher position is keyboard-selectable and follows the saved corner', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.evaluate(() => {
      document.getElementById('settings').open = true;
      document.querySelector('input[name="launcher"][value="br"]').focus();
    });
    // A launcher combination stays in its group and never reaches the settings
    // link. Shift makes event.key a symbol, so event.code must pick the digit.
    const openTabs = context.pages().length;
    await panel.keyboard.press('Control+Shift+1');
    await panel.waitForTimeout(200);
    await expect(panel.locator('input[name="launcher"][value="br"]')).toBeChecked();
    expect(context.pages().length).toBe(openTabs);

    await panel.keyboard.press('Control+Shift+2');
    await expect(panel.locator('input[name="launcher"][value="bl"]')).toBeChecked();
    // Bare, extra-modifier, repeated, and composing digits do nothing.
    // Synthetic events keep browser shortcuts out of the harness.
    await panel.locator('input[name="launcher"][value="bl"]').evaluate((radio) => {
      const cases = [
        { key: '3', code: 'Digit3' },
        { key: '3', code: 'Digit3', altKey: true, ctrlKey: true, shiftKey: true },
        { key: '3', code: 'Digit3', metaKey: true, ctrlKey: true, shiftKey: true },
        { key: '3', code: 'Digit3', ctrlKey: true, shiftKey: true, repeat: true },
        { key: '3', code: 'Digit3', ctrlKey: true, shiftKey: true, isComposing: true },
        { key: '3', code: 'Numpad3', ctrlKey: true, shiftKey: true },
      ];
      for (const init of cases) radio.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    });
    await expect(panel.locator('input[name="launcher"][value="bl"]')).toBeChecked();
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return getComputedStyle(host).left;
    })).toBe('16px');
  } finally {
    await context.close();
  }
});

test('composer number keys send, prepare, pause, repeat, cancel, and open settings', async () => {
  const { context, extensionId } = await launch({
    voice: { available: 'downloadable', permission: 'prompt', gum: 'grant' },
  });
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    expect((await voiceState(panel)).starts).toBe(0);

    await panel.locator('#listen').focus();
    await expect(panel.locator('#listen')).toHaveText('2 Prepare voice');
    await panel.keyboard.press('Control+Shift+2');
    await expect.poll(async () => await announcements(panel), { timeout: 10_000 })
      .toContain('Voice ready.');
    expect((await voiceState(panel)).starts).toBe(0);

    await panel.locator('#pause').focus();
    await panel.keyboard.press('Control+Shift+3');
    await expect.poll(async () => await announcements(panel)).toContain('Paused.');
    await expect.poll(async () => (await voiceState(panel)).active).toBe(false);

    await panel.locator('#message').fill('What is this page about? Read the second paragraph.');
    await panel.locator('#send').focus();
    await panel.keyboard.press('Control+Shift+1');
    await expect(panel.locator('#ask-question')).toContainText('page text', { timeout: 15_000 });

    const beforeRepeat = await announcements(panel);
    await panel.locator('#repeat').focus();
    await panel.keyboard.press('Control+Shift+4');
    await expect.poll(async () => (await announcements(panel)).length).toBeGreaterThan(beforeRepeat.length);
    await expect(panel.locator('#ask-question')).toContainText('page text');

    await panel.locator('#cancel').focus();
    await panel.keyboard.press('Control+Shift+5');
    await expect(panel.locator('#ask')).toBeHidden();

    await expect(panel.locator('#settings')).toHaveJSProperty('open', false);
    await panel.locator('#send').focus();
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toHaveJSProperty('open', true);
    // Focus followed the click; 8 in the settings group closes it again.
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toHaveJSProperty('open', false);
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
    await panel.locator('#send').focus();
    await panel.keyboard.press('Control+Shift+8');
    await expect(panel.locator('#settings')).toHaveJSProperty('open', true);

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

    await panel.locator('#settings').evaluate((details) => { details.open = true; });
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
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 0);
    await expect(page.locator('input[aria-label="Monday 14:00"]')).toBeChecked();

    await panel.locator('#undo').focus();
    await panel.keyboard.press('Control+Shift+6');
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
    expect(await panel.locator('#sr-alert')).toHaveText('Could not close the assistant. native close failed');
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
      document.getElementById('settings').open = true;
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
    await answerWhen(panel, 'Run this?', 0);
    await answerWhen(panel, 'Keep these changes?', 1);
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
    await answerWhen(panel, 'Keep these changes?', 0);

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
    expect(requests.every((entry) => !JSON.stringify(entry.body).includes('"type":"image"'))).toBe(true);
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
