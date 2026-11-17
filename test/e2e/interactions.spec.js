import { test, expect } from '@playwright/test';
import {
  announcements,
  answer,
  answerWhen,
  launch,
  mockRequests,
  openFixture,
  openPanel,
  resetMock,
  sendText,
  undoLastChange,
} from './helpers.js';

// Two-step confirmation for an irreversible proposal.
async function run(panel) {
  await answerWhen(panel, 'Run this?', 0);
  await answerWhen(panel, 'Run anyway?', 0);
}

// One confirmation for a reversible change.
async function edit(panel) {
  await answerWhen(panel, 'Run this?', 0);
}

test('browser text entry commits a new value and clearing does not submit', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Interaction inputs');

    await sendText(panel, 'Interaction fill name');
    await answerWhen(panel, 'page text', 0);
    await edit(panel);
    await expect(page.locator('#name')).toHaveValue('Alex Morgan');
    await expect(page.locator('#committed')).toHaveText('Alex Morgan');
    await expect(page.locator('#submits')).toHaveText('0');
    await expect(panel.locator('#transcript')).toContainText('Committed name: Alex Morgan');

    await sendText(panel, 'Interaction clear name');
    await edit(panel);
    await expect(page.locator('#name')).toHaveValue('');
    await expect(page.locator('#committed')).toHaveText('');
    await expect(page.locator('#submits')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('autocomplete keeps focus, then the suggestion and blur commit', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction autocomplete');
    await answerWhen(panel, 'page text', 0);
    await edit(panel);
    await run(panel);
    await run(panel);

    await expect(page.locator('#contact')).toHaveValue('Alice');
    await expect(page.locator('#contact-picked')).toHaveText('Alice');
    await expect(panel.locator('#transcript')).toContainText('Selected contact: Alice');
  } finally {
    await context.close();
  }
});

test('a long field is replaced fully and undo restores every character', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const initial = await page.locator('#notes').inputValue();
    expect(initial.length).toBe(1024);
    const panel = await openPanel(context, extensionId);

    await sendText(panel, 'Interaction long note');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await undoLastChange(panel);
    await answerWhen(panel, 'Undo this change?', 0);

    await expect(page.locator('#notes')).toHaveValue(initial);
    expect(await page.locator('#notes').inputValue()).toContain('Line one with spaces');
  } finally {
    await context.close();
  }
});

test('a later edit blocks undo of a long field', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction long note');
    await answerWhen(panel, 'page text', 0);
    await edit(panel);
    await expect(page.locator('#notes')).toHaveValue(/^Replacement text/u, { timeout: 30_000 });

    await page.evaluate(() => {
      const field = document.getElementById('notes');
      field.value = `${field.value.slice(0, 700)}X${field.value.slice(701)}`;
    });
    await panel.evaluate(() => document.getElementById('undo').click());
    await expect.poll(async () => (await announcements(panel)).includes('Undo stopped')).toBe(true);
    expect(await page.locator('#notes').inputValue()).toContain('X');
  } finally {
    await context.close();
  }
});

test('oversized and read-only fields are refused before typing', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);

    await sendText(panel, 'Interaction huge archive note');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await expect(panel.locator('#transcript')).toContainText('too large to replace safely');
    expect((await page.locator('#huge').inputValue()).length).toBe(65_537);

    await sendText(panel, 'Interaction readonly code');
    await expect(panel.locator('#transcript')).toContainText('read-only');
    await expect(panel.locator('#ask')).toBeHidden();
    await expect(page.locator('#locked')).toHaveValue('LOCKED');
  } finally {
    await context.close();
  }
});

test('focus stealing and rich text cannot corrupt another field', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);

    await sendText(panel, 'Interaction focus stealing');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'Run this?', 0);
    await expect(panel.locator('#transcript')).toContainText('lost focus');
    await expect(page.locator('#steal')).toHaveValue('');
    await expect(page.locator('#other')).toHaveValue('untouched');

    await sendText(panel, 'Interaction rich note');
    await run(panel);
    await expect(page.locator('#rich')).toHaveText('Updated rich note 😀');
    await expect.poll(async () => (await announcements(panel)).includes('cannot be undone')).toBe(true);
  } finally {
    await context.close();
  }
});

test('keys type characters, delete, and fire a bounded shortcut', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);

    await sendText(panel, 'Interaction keys');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(page.locator('#kbd')).toHaveText('abca|SENT');
    await expect(page.locator('#ask')).toBeHidden();

    await sendText(panel, 'Interaction meta enter');
    await run(panel);
    await expect(page.locator('#kbd')).toHaveText('abca|SENT|META');
  } finally {
    await context.close();
  }
});

test('Control plus A selects only the focused field', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction control a');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect.poll(() => page.evaluate(() => {
      const field = document.getElementById('name');
      return document.activeElement === field
        && field.selectionStart === 0
        && field.selectionEnd === field.value.length;
    })).toBe(true);
  } finally {
    await context.close();
  }
});

test('clipboard shortcuts are refused before execution', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction clipboard');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('Control or Meta cannot be combined with c');
    await expect(panel.locator('#ask')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('Tab moves focus and the next field can be filled', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction tab');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await edit(panel);
    await expect(page.locator('#notes')).toHaveValue('Tabbed name');
    await expect(page.locator('#committed')).toHaveText('Old Name');
  } finally {
    await context.close();
  }
});

test('date fields keep the native value path', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction date');
    await answerWhen(panel, 'page text', 0);
    await edit(panel);
    await expect(page.locator('#when')).toHaveValue('2026-12-01');
    await expect(page.locator('#when-model')).toHaveText('2026-12-01');
  } finally {
    await context.close();
  }
});

test('double click opens a real editor and the rename commits', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction double click');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await edit(panel);
    await run(panel);
    await expect(page.locator('#rename')).toHaveText('Annual report');
  } finally {
    await context.close();
  }
});

test('right click opens the page menu and a menu command runs', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction right click');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await run(panel);
    await expect(page.locator('#reviewed')).toHaveText('yes');
  } finally {
    await context.close();
  }
});

test('hover reveals a submenu that can then be observed and clicked', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction hover options');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await run(panel);
    await expect(page.locator('#archived')).toHaveText('yes');
  } finally {
    await context.close();
  }
});

test('a held press commits only once', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction hold confirm');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(page.locator('#held')).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('Cancel releases a held press and later actions still work', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction cancel hold');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await panel.evaluate(() => document.getElementById('cancel').click());
    await expect(page.locator('#held')).toHaveText('0');

    await sendText(panel, 'Interaction single click');
    await run(panel);
    await expect(page.locator('#single')).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('Escape cancels a busy turn when no choice is open', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction cancel hold');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await panel.keyboard.press('Escape');
    await expect.poll(() => announcements(panel)).toContain('Cancelled the current action.');
    await expect(page.locator('#held')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('Shift extends the selection and does not stick to the next click', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction shift click');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await run(panel);
    await expect(page.locator('#selected')).toHaveText('Item one, Item two, Item three');
    await edit(panel);
    await expect(page.locator('#selected')).toHaveText('Item two');
  } finally {
    await context.close();
  }
});

test('a same-frame mouse drag changes the visible order', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction drag rows');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(page.locator('#order')).toHaveText('gamma alpha beta');
  } finally {
    await context.close();
  }
});

test('a drag whose endpoint moved is refused', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction drag moved');
    await answerWhen(panel, 'page text', 0);
    // The row must move after the proposal snapshot and before confirmation.
    await expect(panel.locator('#ask-question')).toContainText('Run this?');
    await page.evaluate(() => {
      const row = document.createElement('li');
      row.className = 'row';
      row.id = 'row-new';
      row.textContent = 'New';
      document.getElementById('list').prepend(row);
    });
    await run(panel);
    await expect(panel.locator('#transcript')).toContainText('Page state changed');
    await expect(page.locator('#order')).toHaveText('alpha beta gamma');
  } finally {
    await context.close();
  }
});

test('a drag path across a password or frame is refused', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction drag across secret');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(panel.locator('#transcript')).toContainText('masked or embedded area');
    await expect(page.locator('#order')).toHaveText('alpha beta gamma');

    await sendText(panel, 'Interaction drag into frame');
    await expect(panel.locator('#transcript')).toContainText('not in the observed page snapshot');
    await expect(panel.locator('#ask')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('scrolling a list reveals its own content and not the page', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-scroll');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction scroll list down');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(page.locator('#deep')).toHaveText('Deep item selected');
    const positions = await page.evaluate(() => ({
      list: document.getElementById('vlist').scrollTop,
      strip: document.getElementById('hlist').scrollLeft,
      page: window.scrollY,
    }));
    expect(positions.list).toBeGreaterThan(0);
    expect(positions.strip).toBe(0);
    expect(positions.page).toBe(0);
  } finally {
    await context.close();
  }
});

test('horizontal and window scrolling stay independent', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-scroll');
    const panel = await openPanel(context, extensionId);

    await sendText(panel, 'Interaction scroll horizontal');
    await answerWhen(panel, 'page text', 0);
    await expect.poll(() => page.evaluate(() => document.getElementById('hlist').scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    expect(await page.evaluate(() => document.getElementById('vlist').scrollTop)).toBe(0);

    await sendText(panel, 'Interaction scroll window');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('scrolling a list reaches a boundary without scrolling the page', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-scroll');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction scroll boundary');
    await answerWhen(panel, 'page text', 0);
    await expect(panel.locator('#transcript')).toContainText('cannot scroll further', { timeout: 40_000 });
    const edge = await page.evaluate(() => {
      const list = document.getElementById('vlist');
      return {
        top: list.scrollTop,
        client: list.clientHeight,
        height: list.scrollHeight,
        page: window.scrollY,
      };
    });
    expect(edge.top + edge.client).toBe(edge.height);
    expect(edge.page).toBe(0);
    await expect.poll(async () => (await mockRequests())
      .flatMap((request) => request.body.messages)
      .filter((message) => message.role === 'tool')
      .some((message) => String(message.content).includes('"moved":false')), { timeout: 5_000 }).toBe(true);
  } finally {
    await context.close();
  }
});

test('a container scroll invalidates an older screenshot point', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-scroll');
    const panel = await openPanel(context, extensionId);
    await sendText(panel, 'Interaction scroll stale screenshot');
    await answerWhen(panel, 'page text', 0);
    await answerWhen(panel, 'screenshot', 0);
    await expect(panel.locator('#transcript')).toContainText('not in the observed page snapshot');
    await expect(page.locator('#deep')).toHaveText('Deep item');
  } finally {
    await context.close();
  }
});

// One closed loop per new primitive over the Anthropic wire format.
test('anthropic: text entry and clearing commit through the browser', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-inputs');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'Interaction fill name');
    await answerWhen(panel, 'page text', 0);
    await edit(panel);
    await expect(page.locator('#name')).toHaveValue('Alex Morgan');
    await expect(page.locator('#committed')).toHaveText('Alex Morgan');
  } finally {
    await context.close();
  }
});

test('anthropic: a hover exposes a submenu that then clicks', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-pointer');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'Interaction hover options');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await run(panel);
    await expect(page.locator('#archived')).toHaveText('yes');
  } finally {
    await context.close();
  }
});

test('anthropic: scrolling a container reveals its own content', async () => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/interaction-scroll');
    const panel = await openPanel(context, extensionId, { protocol: 'anthropic' });
    await sendText(panel, 'Interaction scroll list down');
    await answerWhen(panel, 'page text', 0);
    await run(panel);
    await expect(page.locator('#deep')).toHaveText('Deep item selected');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await context.close();
  }
});
