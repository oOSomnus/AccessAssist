import { test, expect } from '@playwright/test';
import { launch, openFixture, openPanel } from './helpers.js';

test('extension loads, injects one launcher and opens the panel document', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await openFixture(context, '/article');
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return Boolean(host?.shadowRoot?.querySelector('#launcher-open'));
    })).toBe(true);

    const launcher = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      const button = host.shadowRoot.querySelector('#launcher-open');
      return {
        count: document.querySelectorAll('#accessassist-launcher-host').length,
        label: button.getAttribute('aria-label'),
        tag: button.tagName,
        tabIndex: button.tabIndex,
      };
    });
    expect(launcher.count).toBe(1);
    expect(launcher.label).toContain('AccessAssist');
    expect(launcher.tag).toBe('BUTTON');
    expect(launcher.tabIndex).toBe(0);

    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#page-line')).toContainText('Event schedule');
    await expect(panel.locator('#settings')).toBeVisible();
    await expect(panel.locator('#mode-line')).toContainText('Guide');
  } finally {
    await context.close();
  }
});

test('an old TTS preference is ignored and removed', async () => {
  const { context, extensionId, worker } = await launch();
  try {
    await openFixture(context, '/article');
    await worker.evaluate(() => chrome.storage.local.set({ outputMode: 'tts' }));
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#output-mode')).toHaveCount(0);
    await expect.poll(async () => worker.evaluate(
      async () => (await chrome.storage.local.get('outputMode')).outputMode,
    )).toBeUndefined();
    await expect.poll(async () => (await panel.evaluate(
      () => window.__aaAnnouncements ?? [],
    )).join(' ')).toContain('hear the introduction again');
  } finally {
    await context.close();
  }
});

test('the injected launcher reports a voice intent for its own page', async () => {
  const { context, worker } = await launch();
  try {
    const page = await openFixture(context, '/article');
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return Boolean(host?.shadowRoot?.querySelector('#launcher-open'));
    })).toBe(true);
    const target = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes('/article'));
      return { tabId: tab.id, windowId: tab.windowId };
    });

    await page.locator('#accessassist-launcher-host #launcher-open').click();
    await expect.poll(() => worker.evaluate(async (windowId) => {
      const key = `intent:${windowId}`;
      return (await chrome.storage.session.get(key))[key] ?? null;
    }, target.windowId), { timeout: 5_000 }).toMatchObject({
      mode: 'voice',
      source: 'launcher',
      tabId: target.tabId,
      windowId: target.windowId,
    });

    // Headless Chrome may refuse the real side panel; the launcher must say so
    // instead of claiming it opened.
    const status = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return host?.shadowRoot?.querySelector('[role="status"]')?.textContent ?? '';
    });
    if (status) expect(status).toContain('Could not open');
  } finally {
    await context.close();
  }
});


