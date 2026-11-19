import { test, expect } from '@playwright/test';
import {
  announcementEntries,
  answer,
  answerWhen,
  launch,
  mockRequests,
  openFixture,
  openPanel,
  PAGE_BASE,
  resetMock,
  sendText,
} from './helpers.js';

async function run(panel) {
  await answerWhen(panel, 'Run this?', 0);
  await answerWhen(panel, 'Run anyway?', 0);
}

function children(context) {
  return context.pages().filter((page) => page.url().includes('/action-child'));
}

test('a noopener page can be adopted and the task continues there', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await answerWhen(panel, 'Continue on a new page?', 0);
    await run(panel);

    await expect(panel.locator('#page-line')).toContainText('Child report');
    await expect(panel.locator('#transcript')).toContainText('Child status: finished');
    const pages = children(context);
    expect(pages.length).toBe(1);
    await expect(pages[0].locator('#child-status')).toHaveText('finished');
  } finally {
    await context.close();
  }
});

test('a window opened by the page is also offered and adopted', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open popup');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await answerWhen(panel, 'Continue on a new page?', 0);
    await run(panel);

    await expect(panel.locator('#page-line')).toContainText('Child report');
    const pages = children(context);
    expect(pages.length).toBe(1);
    await expect(pages[0].locator('#child-status')).toHaveText('finished');
  } finally {
    await context.close();
  }
});

test('observe_page continues from the returned cursor', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    await page.evaluate(() => {
      const filler = 'x '.repeat(1500);
      for (let index = 0; index < 20; index += 1) {
        const paragraph = document.createElement('p');
        paragraph.textContent = filler;
        document.body.append(paragraph);
      }
      const marker = document.createElement('p');
      marker.textContent = 'Far marker after the first page.';
      document.body.append(marker);
    });
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'observe twice');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Read the far marker.', { timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test('staying keeps the opened page and the original binding', async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#ask-question')).toContainText('Continue on a new page?');
    const before = context.pages().length;
    await answer(panel, 1);
    await expect(panel.locator('#transcript')).toContainText('left the new tab open');
    await expect(panel.locator('#page-line')).toContainText('Action pages');
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.url ?? '';
    })).toBe(`${PAGE_BASE}/action-pages`);
    expect(context.pages().length).toBe(before);
  } finally {
    await context.close();
  }
});

test('a cross-site page asks again before any text is read', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open cross-site');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await answerWhen(panel, 'Continue on a new page?', 0);
    await expect(panel.locator('#page-line')).toContainText('Child report');

    await answerWhen(panel, 'page text', 1);
    await expect(panel.locator('#transcript')).toContainText('did not read the report');
    const requests = await mockRequests();
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('Child status');
  } finally {
    await context.close();
  }
});

test('two opened pages require an explicit choice', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open two reports');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await answerWhen(panel, 'Continue on a new page?', 1);
    await run(panel);

    const pages = children(context);
    expect(pages.length).toBe(2);
    await expect.poll(async () => {
      const statuses = await Promise.all(pages.map((page) => page.locator('#child-status').textContent()));
      return `${statuses.filter((status) => status === 'finished').length}/${statuses.filter((status) => status === 'open').length}`;
    }).toBe('1/1');
    const states = await Promise.all(pages.map(async (page) => ({
      report: new URL(page.url()).searchParams.get('report'),
      status: await page.locator('#child-status').textContent(),
    })));
    expect(states.map((state) => state.report).sort()).toEqual(['one', 'two']);
    expect(states.filter((state) => state.status === 'finished')).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('a page the user picks during execution is not treated as an action page', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#ask-question')).toContainText('Continue on a new page?');

    const manual = await context.newPage();
    await manual.goto(`${PAGE_BASE}/article`);
    await manual.bringToFront();
    await panel.waitForTimeout(250);
    await answer(panel, 1);

    await expect(panel.locator('#page-line')).toContainText('Event schedule');
  } finally {
    await context.close();
  }
});

test('a page closed before the choice is not adopted', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#ask-question')).toContainText('Continue on a new page?');
    await expect.poll(() => children(context).length).toBe(1);
    await children(context)[0].close();
    await answer(panel, 0);

    await expect(panel.locator('#transcript')).toContainText('no longer available');
    await expect(panel.locator('#page-line')).toContainText('Action pages');
  } finally {
    await context.close();
  }
});

test('a page that changes sites before the choice is not adopted', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open moving report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#ask-question')).toContainText('Continue on a new page?');
    await panel.waitForTimeout(2200);
    await answer(panel, 0);

    await expect(panel.locator('#transcript')).toContainText('changed sites');
    await expect(panel.locator('#page-line')).toContainText('Action pages');
  } finally {
    await context.close();
  }
});

test('anthropic: an opened noopener page is adopted and finished', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await answerWhen(panel, 'Continue on a new page?', 0);
    await run(panel);
    await expect(panel.locator('#page-line')).toContainText('Child report');
    const pages = children(context);
    expect(pages.length).toBe(1);
    await expect(pages[0].locator('#child-status')).toHaveText('finished');
  } finally {
    await context.close();
  }
});

test('a page that never loads is not offered', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    const blanksBefore = context.pages().filter((page) => page.url() === 'about:blank').length;
    await sendText(panel, 'Action page open blank');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#transcript')).toContainText('The blank page was not adopted.', { timeout: 20_000 });
    await expect(panel.locator('#ask')).toBeHidden();
    await expect(panel.locator('#page-line')).toContainText('Action pages');
    await expect.poll(() => context.pages().filter((page) => page.url() === 'about:blank').length)
      .toBe(blanksBefore + 1);
  } finally {
    await context.close();
  }
});

test('cancelling the page choice keeps both pages and the original binding', async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/action-pages');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Action page open report');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#ask-question')).toContainText('Continue on a new page?');
    await panel.evaluate(() => document.getElementById('cancel').click());
    await expect(panel.locator('#transcript')).toContainText('left the new tab open');
    await expect(panel.locator('#ask')).toBeHidden();
    await expect(panel.locator('#page-line')).toContainText('Action pages');
    expect(children(context).length).toBe(1);
    await expect.poll(() => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.url ?? '';
    })).toBe(`${PAGE_BASE}/action-pages`);
  } finally {
    await context.close();
  }
});

test('the panel follows the tab on screen and the next command reads that page', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    await openFixture(context, '/images');
    await expect(panel.locator('#page-line')).toContainText('Image test');
    await expect.poll(async () => (await announcementEntries(panel)).some((text) => text.includes('Current page: Image test')))
      .toBe(true);

    await sendText(panel, 'Refusal check');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('I read Image test.');
    const bodies = JSON.stringify((await mockRequests()).map((request) => request.body));
    expect(bodies).not.toContain('Event schedule');
  } finally {
    await context.close();
  }
});

test('a tab that is not a web page releases the page left behind', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');

    const blank = await context.newPage();
    await blank.bringToFront();
    await expect(panel.locator('#page-line')).toContainText(/unreadable|No readable page/u);

    await sendText(panel, 'Refusal check');
    await expect(panel.locator('#transcript')).toContainText('I could not read this page.');
    expect((await announcementEntries(panel)).some((text) => text.includes('page text'))).toBe(false);
    const bodies = JSON.stringify((await mockRequests()).map((request) => request.body));
    expect(bodies).not.toContain('Event schedule');
    expect(bodies).toContain('No readable page is on screen');
  } finally {
    await context.close();
  }
});

test('switching tabs while an action waits for confirmation runs nothing out of sight', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Submit the form.');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#ask-question')).toContainText('Run this?');

    await openFixture(context, '/images');
    await panel.waitForTimeout(250);
    await answer(panel, 0);

    await expect(panel.locator('#page-line')).toContainText('Image test');
    await expect(panel.locator('#ask')).toBeHidden();
    await expect(page.locator('#submits')).toHaveText('0');
  } finally {
    await context.close();
  }
});
