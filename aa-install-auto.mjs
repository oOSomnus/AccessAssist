import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './scripts/live-check.mjs';
const EXT = path.resolve('extension');

// The profile directory is owned by this run; remove it even when setup fails
// or the context reports a close error.
export async function runInstall({ launch = (...args) => chromium.launchPersistentContext(...args) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-autoinstall-'));
  let context;
  try {
    context = await launch(dir, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await page.waitForTimeout(500);
    const result = await page.evaluate(async () => {
      const R = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!R) return { error: 'no API' };
      const activeBefore = navigator.userActivation?.isActive ?? null;
      const before = await R.available({ langs: ['en-US'], processLocally: true }).catch((e) => `throw:${e.message}`);
      let install;
      const started = Date.now();
      try {
        install = await R.install({ langs: ['en-US'], processLocally: true });
      } catch (e) {
        install = `throw:${e.name}:${e.message}`;
      }
      const after = await R.available({ langs: ['en-US'], processLocally: true }).catch((e) => `throw:${e.message}`);
      return { activeBefore, before, install, after, ms: Date.now() - started };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await runInstall();
