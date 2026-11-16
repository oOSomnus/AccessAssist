import { test, expect } from '@playwright/test';
import { launch, openFixture, openPanel } from './helpers.js';

test('extension loads, injects one launcher and opens the panel document', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await openFixture(context, '/article');
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return Boolean(host?.shadowRoot?.querySelector('button'));
    })).toBe(true);

    const launcher = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      const button = host.shadowRoot.querySelector('button');
      return {
        count: document.querySelectorAll('#accessassist-launcher-host').length,
        label: button.getAttribute('aria-label'),
        tag: button.tagName,
        tabIndex: button.tabIndex,
      };
    });
    expect(launcher.count).toBe(1);
    expect(launcher.label).toContain('Alt+Z');
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

test('the injected launcher reports a voice intent for its own page', async () => {
  const { context, worker } = await launch();
  try {
    const page = await openFixture(context, '/article');
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return Boolean(host?.shadowRoot?.querySelector('button'));
    })).toBe(true);
    const target = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes('/article'));
      return { tabId: tab.id, windowId: tab.windowId };
    });

    await page.locator('#accessassist-launcher-host button').click();
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

test('the replay introduction command is declared with its default shortcut', async () => {
  const { context, extensionId } = await launch();
  try {
    const panel = await openPanel(context, extensionId);
    const manifest = await panel.evaluate(
      () => chrome.runtime.getManifest().commands['replay-introduction'],
    );
    expect(manifest.suggested_key.default).toBe('Alt+Shift+H');
    const commands = await panel.evaluate(() => chrome.commands.getAll());
    const replay = commands.find((command) => command.name === 'replay-introduction');
    expect(replay?.shortcut).toBe('Alt+Shift+H');
    await expect(panel.locator('#shortcut-status')).toContainText('Replay the AccessAssist introduction');
  } finally {
    await context.close();
  }
});

