import { expect, test } from '@playwright/test';
import { launch, openFixture, openPanel, resetMock, voiceState } from './helpers.js';

async function attachScreenshot(page, testInfo, name) {
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: 'image/png',
  });
}

function contrastRatio(foreground, background) {
  const parse = (value) => value.match(/[\d.]+/gu).slice(0, 3).map(Number);
  const channel = (value) => {
    const amount = value / 255;
    return amount <= 0.03928 ? amount / 12.92 : ((amount + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([red, green, blue]) => (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
  const first = luminance(parse(foreground));
  const second = luminance(parse(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('appearance: conversation scroll keeps the composer reachable', async ({}, testInfo) => {
  const { context, extensionId } = await launch();
  try {
    await resetMock();
    const page = await openFixture(context, '/article');
    const panel = await openPanel(context, extensionId);
    await panel.setViewportSize({ width: 391, height: 904 });
    await expect(panel.locator('.conversation-empty')).toBeVisible();
    await expect(panel.locator('.conversation-empty')).toHaveText('Ask about this page, an image, or a task.');
    await expect(panel.locator('#settings')).not.toHaveJSProperty('open', true);
    await expect(panel.locator('#voice-help')).not.toHaveJSProperty('open', true);
    await expect(panel.locator('#close-panel')).toHaveCount(1);
    await expect(panel.locator('#close-panel')).toHaveAccessibleName('Close panel');
    await expect(panel.locator('#close-panel')).toHaveText('Close');
    await expect(panel.locator('#composer-hint')).toHaveText('Control or Command plus Enter sends.');
    await expect(panel.locator('#pause')).toHaveText('3 Stop listening');
    expect(await panel.evaluate(() => {
      const ask = document.getElementById('ask');
      const conversation = document.getElementById('conversation');
      return Boolean(ask.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await attachScreenshot(panel, testInfo, 'conversation-empty-391x904');

    await panel.locator('#message').fill('UI layout sample');
    await panel.locator('#send').click();
    await expect(panel.locator('.message-body', { hasText: 'I heard you.' })).toHaveCount(1, { timeout: 30_000 });
    await expect(panel.locator('.message-body').filter({ hasText: 'UI layout sample' })).toHaveCount(1);

    await panel.locator('#message').fill('layout '.repeat(500).trim());
    await panel.locator('#send').click();
    await expect(panel.locator('.message-body', { hasText: 'I heard you.' })).toHaveCount(2, { timeout: 30_000 });
    await expect(panel.locator('#transcript')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(panel.locator('.conversation-empty')).toBeHidden();
    await attachScreenshot(panel, testInfo, 'conversation-391x904');

    const layout = await panel.evaluate(() => {
      const list = document.getElementById('transcript');
      const content = document.querySelector('.panel-content');
      const message = document.getElementById('message').getBoundingClientRect();
      const send = document.getElementById('send').getBoundingClientRect();
      const items = [...list.children].map((item) => {
        const rect = item.getBoundingClientRect();
        const body = item.querySelector('.message-body');
        return {
          role: item.dataset.role,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          overflow: body.scrollWidth - body.clientWidth,
          text: body.textContent,
        };
      });
      const user = items.filter((item) => item.role === 'user').at(-1);
      const assistant = items.filter((item) => item.role === 'assistant').at(-1);
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        listLeft: list.getBoundingClientRect().left,
        listRight: list.getBoundingClientRect().right,
        scrollable: content.scrollHeight > content.clientHeight,
        panelTop: content.getBoundingClientRect().top,
        panelBottom: content.getBoundingClientRect().bottom,
        messageTop: message.top,
        sendBottom: send.bottom,
        viewportHeight: window.innerHeight,
        user,
        assistant,
        items,
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.scrollable).toBe(true);
    expect(layout.user.right).toBeGreaterThan(layout.assistant.left + 48);
    expect(Math.abs(layout.user.right - layout.listRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.assistant.left - layout.listLeft)).toBeLessThanOrEqual(1);
    expect(layout.user.text).toContain('layout layout');
    for (const item of layout.items) expect(item.overflow).toBeLessThanOrEqual(0);
    expect(layout.assistant.top).toBeGreaterThanOrEqual(layout.panelTop - 1);
    expect(layout.assistant.bottom).toBeLessThanOrEqual(layout.panelBottom + 1);
    expect(layout.messageTop).toBeGreaterThanOrEqual(0);
    expect(layout.sendBottom).toBeLessThanOrEqual(layout.viewportHeight);

    // The composer still sends after the transcript has grown and scrolled.
    await panel.locator('#message').fill('Again');
    await panel.locator('#send').click();
    await expect(panel.locator('.message-body', { hasText: 'I heard you.' })).toHaveCount(3, { timeout: 30_000 });
    await expect(panel.locator('#transcript')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });

    // Settings scroll above the composer; every existing action stays reachable.
    await panel.locator('#settings > summary').click();
    await expect(panel.locator('#settings')).toHaveJSProperty('open', true);
    await panel.locator('#api-key').scrollIntoViewIfNeeded();
    await expect(panel.locator('#api-key')).toBeVisible();
    for (const id of ['send', 'listen', 'pause', 'repeat', 'cancel', 'undo', 'close-panel']) {
      await expect(panel.locator(`#${id}`)).toBeVisible();
      await expect(panel.locator(`#${id}`)).toBeEnabled();
    }
    await attachScreenshot(panel, testInfo, 'settings-391x904');

    const readTheme = () => panel.evaluate(() => {
      const body = getComputedStyle(document.body);
      const input = getComputedStyle(document.getElementById('message'));
      const composer = getComputedStyle(document.getElementById('composer'));
      return {
        text: body.color,
        background: body.backgroundColor,
        border: input.borderTopColor,
        surface: composer.backgroundColor,
      };
    });
    const light = await readTheme();
    expect(contrastRatio(light.text, light.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.border, light.surface)).toBeGreaterThanOrEqual(3);

    await panel.emulateMedia({ colorScheme: 'dark' });
    const dark = await readTheme();
    expect(dark.background).not.toBe(light.background);
    expect(contrastRatio(dark.text, dark.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.border, dark.surface)).toBeGreaterThanOrEqual(3);
    await panel.keyboard.press('Tab');
    await panel.locator('#message').focus();
    await attachScreenshot(panel, testInfo, 'sidebar-dark-391x904');

    await panel.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    const forced = await readTheme();
    expect(contrastRatio(forced.text, forced.background)).toBeGreaterThanOrEqual(4.5);
    await attachScreenshot(panel, testInfo, 'sidebar-forced-391x904');

    await panel.emulateMedia({ colorScheme: 'light', forcedColors: 'none', reducedMotion: 'no-preference' });
    await panel.setViewportSize({ width: 1000, height: 760 });
    const wide = await panel.evaluate(() => {
      const settings = document.querySelector('.settings').getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        settingsWidth: settings.width,
        settingsLeft: settings.left,
      };
    });
    expect(wide.settingsWidth).toBeLessThanOrEqual(672 + 1);
    expect(Math.abs(wide.settingsLeft - (wide.viewport - wide.settingsWidth) / 2)).toBeLessThanOrEqual(2);
    await panel.locator('.panel-content').evaluate((element) => { element.scrollTop = 0; });
    await attachScreenshot(panel, testInfo, 'sidebar-1000x760');

    expect((await voiceState(panel)).starts).toBe(0);
    await expect(page.locator('#submits')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('appearance: narrow source consent preserves complete origins and keyboard choice', async ({}, testInfo) => {
  const { context, extensionId } = await launch();
  const longOrigin = `https://${'a'.repeat(63)}.example.test`;
  const question = 'What is this page about? Read the second paragraph.';
  try {
    await resetMock();
    await context.route(`${longOrigin}/**`, (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<html lang="en"><body><p>LONG-ORIGIN-MARKER</p></body></html>',
    }));
    const page = await openFixture(context, '/article');
    let panel = await openPanel(context, extensionId);
    await panel.setViewportSize({ width: 391, height: 904 });
    await page.evaluate((origin) => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.width = '160';
      frame.height = '50';
      frame.addEventListener('load', resolve, { once: true });
      frame.src = `${origin}/frame`;
      document.body.append(frame);
    }), longOrigin);

    await panel.locator('#message').fill(question);
    await panel.locator('#message').press('Control+Enter');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('#ask-sites li')).toHaveCount(2);
    await expect(panel.locator('#ask-sites li').first().locator('span[aria-hidden="true"]'))
      .toHaveText('http://127.0.0.1:4173');
    await expect(panel.locator('#ask-sites li').nth(1).locator('span[aria-hidden="true"]'))
      .toHaveText(longOrigin);
    await expect(panel.locator('#ask-question')).toContainText('Allow these sources');
    await expect(panel.locator('#ask-options button')).toHaveCount(3);
    // An asynchronous question is announced but does not move the user's focus.
    await expect(panel.locator('#ask-options button').first()).not.toBeFocused();
    await panel.locator('#ask-options button').first().focus();
    await expect(panel.locator('#ask-options button').first()).toBeFocused();
    expect(await panel.locator('#ask-options button').allTextContents())
      .toEqual(['1 Allow listed sites', '2 Current site only', '3 Cancel']);
    await expect(panel.locator('#ask-options button').first())
      .toHaveAccessibleName('Choice 1, Allow listed sites');

    for (const size of [
      { width: 391, height: 904 },
      { width: 320, height: 760 },
      { width: 160, height: 640 },
    ]) {
      await panel.setViewportSize(size);
      await expect(panel.locator('#ask-sites li').nth(1).locator('span[aria-hidden="true"]'))
        .toHaveText(longOrigin);
      const check = await panel.evaluate(() => {
        const sites = [...document.querySelectorAll('#ask-sites li')];
        const siteList = document.getElementById('ask-sites');
        const options = [...document.querySelectorAll('#ask-options button')];
        return {
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          siteListOverflow: siteList.scrollWidth - siteList.clientWidth,
          sites: sites.map((site) => ({
            text: site.querySelector('span[aria-hidden="true"]')?.textContent ?? site.textContent,
            overflow: site.scrollWidth - site.clientWidth,
            textOverflow: getComputedStyle(site).textOverflow,
          })),
          options: options.map((option) => ({
            text: option.textContent,
            overflow: option.scrollWidth - option.clientWidth,
            background: getComputedStyle(option).backgroundColor,
          })),
        };
      });
      expect(check.scrollWidth).toBeLessThanOrEqual(check.width);
      expect(check.siteListOverflow).toBeLessThanOrEqual(0);
      expect(check.sites).toHaveLength(2);
      expect(check.sites[1].text).toBe(longOrigin);
      expect(check.sites[1].overflow).toBeLessThanOrEqual(0);
      expect(check.sites[1].textOverflow).not.toBe('ellipsis');
      expect(check.options).toHaveLength(3);
      expect(new Set(check.options.map((option) => option.background)).size).toBe(1);
      for (const option of check.options) expect(option.overflow).toBeLessThanOrEqual(0);

      await panel.locator('#ask-question').scrollIntoViewIfNeeded();
      await attachScreenshot(panel, testInfo, `consent-top-${size.width}x${size.height}`);
      await panel.locator('#ask-sites li').nth(1).scrollIntoViewIfNeeded();
      await attachScreenshot(panel, testInfo, `consent-origin-${size.width}x${size.height}`);
      const lastChoice = panel.locator('#ask-options button').last();
      await lastChoice.scrollIntoViewIfNeeded();
      const choiceBox = await lastChoice.boundingBox();
      expect(choiceBox.x).toBeGreaterThanOrEqual(0);
      expect(choiceBox.x + choiceBox.width).toBeLessThanOrEqual(size.width + 1);
      expect(choiceBox.y + choiceBox.height).toBeLessThanOrEqual(size.height + 1);
      await attachScreenshot(panel, testInfo, `consent-${size.width}x${size.height}`);
    }

    await panel.setViewportSize({ width: 391, height: 904 });
    // Digits typed into the textarea stay text and never consume the choice.
    await panel.locator('#message').focus();
    await panel.keyboard.press('2');
    await expect(panel.locator('#message')).toHaveValue('2');
    await expect(panel.locator('#ask')).toBeVisible();
    await expect(panel.locator('#ask-options button')).toHaveCount(3);

    await panel.locator('#ask-options button').first().focus();
    // The cancelled turn immediately asks again; record the state restored by
    // Escape at the moment focus returns instead of racing the next prompt.
    await panel.evaluate(() => {
      window.__aaEscapeState = null;
      document.addEventListener('focusin', (event) => {
        if (!window.__aaEscapeState && event.target?.id === 'message') {
          window.__aaEscapeState = {
            askHidden: document.getElementById('ask').hidden,
            sites: document.querySelectorAll('#ask-sites li').length,
          };
        }
      });
    });
    await panel.keyboard.press('Escape');
    await expect.poll(() => panel.evaluate(() => window.__aaEscapeState))
      .toEqual({ askHidden: true, sites: 0 });

    // A fresh panel asks again; explicit consent reads the paragraph but never
    // submits the page form.
    await panel.close();
    panel = await openPanel(context, extensionId);
    await panel.setViewportSize({ width: 391, height: 904 });
    await panel.locator('#message').fill(question);
    await panel.locator('#message').press('Control+Enter');
    await expect(panel.locator('#ask-sites')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('#ask-sites li')).toHaveCount(2);
    await panel.locator('#ask-options button').first().click();
    await expect(panel.locator('#transcript'))
      .toContainText('Second paragraph: meet at the community center on Friday at 3 p.m. Bring water.', { timeout: 30_000 });
    await expect(panel.locator('#transcript')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(page.locator('#submits')).toHaveText('0');
  } finally {
    await context.close();
  }
});

test('appearance: setup and launcher remain usable across display modes', async ({}, testInfo) => {
  const { context, extensionId, worker } = await launch({
    voice: { available: 'available', permission: 'prompt', gum: 'deny' },
  });
  try {
    await resetMock();
    const setup = await context.newPage();
    await setup.setViewportSize({ width: 391, height: 904 });
    await setup.goto(`chrome-extension://${extensionId}/sidepanel.html?setup=1`);
    await expect(setup.locator('body')).toHaveClass(/setup-page/);
    await expect(setup.locator('#composer')).toBeHidden();
    await expect(setup.locator('#settings')).toBeHidden();
    await expect(setup.locator('#voice-help')).not.toHaveJSProperty('open', true);
    await expect(setup.locator('#close-panel')).toBeHidden();
    await expect(setup.locator('[data-number-scope="output"]')).toHaveCount(0);
    await expect(setup.locator('#start-using')).toBeVisible();
    await expect(setup.locator('#start-using')).toHaveText('1 Prepare voice');
    await expect(setup.locator('#return-assistant')).toBeHidden();
    await attachScreenshot(setup, testInfo, 'setup-prepare-391x904');

    await setup.locator('#start-using').click();
    await expect(setup.locator('#start-using')).toHaveText('1 Retry', { timeout: 30_000 });
    await expect(setup.locator('#voice-status')).toContainText(/blocked|denied/);
    await expect(setup.locator('#start-using')).toBeFocused();
    await attachScreenshot(setup, testInfo, 'setup-retry-391x904');

    await setup.evaluate(() => {
      window.__aaVoice.gum = 'grant';
      window.__aaVoice.permission = 'granted';
    });
    await setup.locator('#start-using').click();
    await expect(setup.locator('#return-assistant')).toBeVisible({ timeout: 30_000 });
    await expect(setup.locator('#return-assistant')).toBeFocused();
    await expect(setup.locator('#voice-status')).toContainText('Speech is ready on this device.');
    await expect(setup.locator('#start-using')).toBeHidden();
    expect((await voiceState(setup)).starts).toBe(0);
    expect(await setup.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('18px');
    // Put focus in the keyboard modality so the visible ring is the real one,
    // not a pointer-focused state.
    await setup.keyboard.press('Tab');
    await setup.locator('#return-assistant').focus();
    await expect(setup.locator('#return-assistant')).toBeFocused();

    const backgrounds = [];
    for (const mode of [
      { name: 'setup-391x904-light', size: { width: 391, height: 904 }, media: { colorScheme: 'light' } },
      { name: 'setup-391x904-dark', size: { width: 391, height: 904 }, media: { colorScheme: 'dark' } },
      { name: 'setup-1000x760-light', size: { width: 1000, height: 760 }, media: { colorScheme: 'light' } },
      { name: 'setup-1000x760-dark', size: { width: 1000, height: 760 }, media: { colorScheme: 'dark' } },
      {
        name: 'setup-391x904-forced',
        size: { width: 391, height: 904 },
        media: { colorScheme: 'light', forcedColors: 'active', reducedMotion: 'reduce' },
      },
    ]) {
      await setup.setViewportSize(mode.size);
      await setup.emulateMedia(mode.media);
      const appearance = await setup.evaluate(() => {
        const bar = document.querySelector('.bar').getBoundingClientRect();
        const card = document.getElementById('voice-setup').getBoundingClientRect();
        const button = document.getElementById('return-assistant');
        const buttonRect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const bodyStyle = getComputedStyle(document.body);
        return {
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          background: bodyStyle.backgroundColor,
          textColor: bodyStyle.color,
          buttonBackground: style.backgroundColor,
          buttonColor: style.color,
          barLeft: bar.left,
          barRight: bar.right,
          cardLeft: card.left,
          cardRight: card.right,
          buttonVisible: buttonRect.width > 0 && buttonRect.height > 0,
          buttonHeight: buttonRect.height,
          buttonRight: buttonRect.right,
          composerHidden: getComputedStyle(document.getElementById('composer')).display === 'none',
          settingsHidden: getComputedStyle(document.querySelector('.settings')).display === 'none',
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          borderStyle: style.borderTopStyle,
          borderWidth: style.borderTopWidth,
        };
      });
      backgrounds.push(appearance.background);
      expect(contrastRatio(appearance.textColor, appearance.background)).toBeGreaterThanOrEqual(4.5);
      if (!mode.name.endsWith('forced')) {
        // Emulated forced colors report palette placeholders, not rendered
        // colors; the screenshot and system pair cover that mode.
        expect(contrastRatio(appearance.buttonColor, appearance.buttonBackground)).toBeGreaterThanOrEqual(4.5);
      }
      expect(appearance.scrollWidth).toBeLessThanOrEqual(appearance.width);
      expect(appearance.barLeft).toBeGreaterThanOrEqual(0);
      expect(appearance.barRight).toBeLessThanOrEqual(appearance.width + 1);
      expect(appearance.cardLeft).toBeGreaterThanOrEqual(0);
      expect(appearance.cardRight).toBeLessThanOrEqual(appearance.width + 1);
      expect(appearance.buttonRight).toBeLessThanOrEqual(appearance.width + 1);
      expect(appearance.buttonVisible).toBe(true);
      expect(appearance.buttonHeight).toBeGreaterThanOrEqual(44);
      expect(appearance.composerHidden).toBe(true);
      expect(appearance.settingsHidden).toBe(true);
      expect(appearance.borderStyle).not.toBe('none');
      expect(appearance.borderWidth).not.toBe('0px');
      if (mode.name.endsWith('forced')) {
        expect(appearance.outlineStyle).toBe('solid');
        expect(appearance.outlineWidth).toBe('3px');
      }
      await attachScreenshot(setup, testInfo, mode.name);
    }
    expect(new Set(backgrounds).size).toBeGreaterThan(1);

    const page = await openFixture(context, '/article');
    await expect.poll(() => page.evaluate(() => Boolean(
      document.getElementById('accessassist-launcher-host')?.shadowRoot?.querySelector('button'),
    ))).toBe(true);
    const launcher = page.locator('#accessassist-launcher-host button');
    await expect(launcher).toHaveAccessibleName(/AccessAssist assistant/);
    const box = await launcher.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(56);
    expect(box.height).toBeGreaterThanOrEqual(56);

    await page.keyboard.press('Tab');
    await launcher.focus();
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      const button = host.shadowRoot.querySelector('button');
      const style = getComputedStyle(button);
      return {
        focused: host.shadowRoot.activeElement === button,
        visible: button.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    })).toMatchObject({ focused: true, visible: true, outlineStyle: 'solid', outlineWidth: '3px' });
    await attachScreenshot(page, testInfo, 'launcher-focus');

    const launcherColors = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return getComputedStyle(host.shadowRoot.querySelector('button')).backgroundColor;
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    const darkColor = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      return getComputedStyle(host.shadowRoot.querySelector('button')).backgroundColor;
    });
    expect(darkColor).not.toBe(launcherColors);
    await attachScreenshot(page, testInfo, 'launcher-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    const forced = await page.evaluate(() => {
      const host = document.getElementById('accessassist-launcher-host');
      const button = host.shadowRoot.querySelector('button');
      const style = getComputedStyle(button);
      return {
        shadow: style.boxShadow,
        borderWidth: style.borderTopWidth,
        color: style.color,
        background: style.backgroundColor,
      };
    });
    expect(forced.shadow).toBe('none');
    expect(parseFloat(forced.borderWidth)).toBeGreaterThanOrEqual(2);
    await attachScreenshot(page, testInfo, 'launcher-forced');
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

    await page.setViewportSize({ width: 160, height: 640 });
    const narrow = await launcher.boundingBox();
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(160);
    expect(narrow.width).toBeLessThanOrEqual(128);
    expect(narrow.height).toBeGreaterThanOrEqual(56);
    expect(await page.evaluate(() => document.querySelectorAll('#accessassist-launcher-host').length)).toBe(1);
    await attachScreenshot(page, testInfo, 'launcher-160x640');

    await page.setViewportSize({ width: 1000, height: 760 });
    const target = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url?.includes('/article'));
      return { tabId: tab.id, windowId: tab.windowId };
    });
    await launcher.click();
    await expect.poll(() => worker.evaluate(async (windowId) => {
      const key = `intent:${windowId}`;
      return (await chrome.storage.session.get(key))[key] ?? null;
    }, target.windowId), { timeout: 5_000 }).toMatchObject({
      mode: 'voice',
      source: 'launcher',
      tabId: target.tabId,
      windowId: target.windowId,
    });
  } finally {
    await context.close();
  }
});
