// Live acceptance: the real extension and the configured Go model must select
// Monday and Wednesday on when2meet.com. The key is read from the environment
// and never printed; the event form is blocked so nothing can be created.
import { launch, openPanel, sendText } from '../test/e2e/helpers.js';
import { DEFAULT_CONFIG } from '../extension/ai.js';
import { checkError, isMain, protocolSelectionError, selectProtocols } from './live-check.mjs';
import { oracleOk, terminalSuccess } from './when2meet-oracle.mjs';

export { oracleOk, panelSettled, terminalSuccess } from './when2meet-oracle.mjs';

const MODEL = 'deepseek-v4.1-flash';
const INSTRUCTION = 'Switch Survey using to Days of the Week. Select Monday and Wednesday only. '
  + 'Leave the event name, times, and all other fields unchanged. Do not create or submit an event. '
  + 'Leave either requested day selected if it is already selected.';

const CONFIGS = [
  { name: 'openai', config: { protocol: 'openai', baseUrl: DEFAULT_CONFIG.baseUrl, model: MODEL } },
  {
    name: 'anthropic',
    config: {
      protocol: 'anthropic',
      baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
      model: MODEL,
    },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only known consent dialogs advance; anything else is a failure, never a
// blind click on the first option.
function consentIndex(question, options) {
  const text = String(question ?? '');
  // Choice labels arrive numbered for voice ("1 Allow", "2 Cancel").
  const labels = options.map((option) => String(option).replace(/^\s*\d+[.):]?\s*/, ''));
  const pick = (matcher) => labels.findIndex((option) => matcher.test(option));
  if (/run anyway/i.test(text)) return pick(/run anyway/i);
  if (/run this/i.test(text)) return pick(/^run\b/i);
  if (/keep these changes/i.test(text)) return pick(/^keep\b/i);
  if (/another site area/i.test(text)) return pick(/^read\b/i);
  if (/page text|screenshot|image/i.test(text)) {
    const allow = pick(/^allow\b/i);
    return allow >= 0 ? allow : pick(/^read\b/i);
  }
  return -1;
}

async function readOracle(page) {
  const raw = await page.evaluate(() => ({
    mode: document.getElementById('DateTypes')?.value ?? null,
    dates: document.getElementById('PossibleDates')?.value ?? null,
    name: document.getElementById('NewEventName')?.value ?? null,
    notBefore: document.getElementById('NoEarlierThan')?.value ?? null,
    notAfter: document.getElementById('NoLaterThan')?.value ?? null,
    zone: document.getElementById('TimeZone')?.value ?? null,
    url: location.href,
  }));
  // The site joins the chosen weekday indexes with "|" (Sunday is 0).
  raw.chosen = String(raw.dates ?? '').split('|').filter(Boolean);
  return raw;
}

// The live form pre-fills times and a zone, so compare against those values
// instead of assuming the controls start blank or at a fixed default.
async function readBaseline(page) {
  try {
    await page.waitForFunction(() => ['NoEarlierThan', 'NoLaterThan', 'TimeZone'].every((id) => {
      const control = document.getElementById(id);
      return control && String(control.value ?? '') !== '';
    }), null, { timeout: 60_000 });
  } catch {
    throw checkError('BASELINE_NOT_POPULATED');
  }
  const oracle = await readOracle(page);
  return {
    name: oracle.name,
    notBefore: oracle.notBefore,
    notAfter: oracle.notAfter,
    zone: oracle.zone,
    url: oracle.url,
  };
}

async function runProtocol({ name, config, key }) {
  const { context, extensionId } = await launch({ locale: 'en-US' });
  const submissions = [];
  try {
    // Any write attempt or create/save URL is recorded and aborted before it
    // can reach the site.
    await context.route('**/*when2meet.com/**', async (route) => {
      const request = route.request();
      const url = request.url();
      const submission = /(?:save|create)[^/]*event/i.test(url);
      if (submission || !/^(GET|HEAD)$/i.test(request.method())) {
        if (submission) submissions.push(url);
        await route.abort();
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto('https://www.when2meet.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    const panel = await openPanel(context, extensionId, {
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      apiKey: key,
    });
    await page.bringToFront();
    const pageLine = await panel.locator('#page-line').textContent();
    if (!/when2meet/i.test(pageLine ?? '')) {
      throw checkError('PANEL_NOT_ON_WHEN2MEET');
    }
    const baseline = await readBaseline(page);

    await sendText(panel, INSTRUCTION);
    const asked = [];
    const deadline = Date.now() + 240_000;
    let state = { busy: null };
    let oracle = await readOracle(page);
    while (Date.now() < deadline) {
      state = await panel.evaluate(() => ({
        askVisible: !document.getElementById('ask').hidden,
        question: document.getElementById('ask-question').textContent ?? '',
        options: [...document.querySelectorAll('#ask-options button')].map((button) => button.textContent ?? ''),
        transcript: document.getElementById('transcript').textContent ?? '',
        busy: document.getElementById('transcript').getAttribute('aria-busy'),
      }));
      if (state.askVisible) {
        const index = consentIndex(state.question, state.options);
        if (index < 0) throw checkError('UNEXPECTED_CONSENT_PROMPT');
        asked.push(state.question);
        await panel.evaluate((position) => {
          const button = document.querySelectorAll('#ask-options button')[position];
          if (!button) throw new Error('The choice disappeared');
          button.click();
        }, index);
        await sleep(400);
        continue;
      }
      oracle = await readOracle(page);
      if (terminalSuccess({ busy: state.busy, oracle }, baseline, submissions)) break;
      await sleep(250);
    }
    const ok = terminalSuccess({ busy: state.busy, oracle }, baseline, submissions);
    const image = `test-results/when2meet-${name}.png`;
    await page.screenshot({ path: image }).catch(() => {});
    const diagnostics = ok ? null : await panel.evaluate(() => ({
      question: document.getElementById('ask-question')?.textContent ?? null,
      options: [...document.querySelectorAll('#ask-options button')].map((button) => button.textContent),
      status: document.getElementById('status')?.textContent ?? null,
      transcript: document.getElementById('transcript')?.textContent?.slice(-1200) ?? null,
      requests: performance.getEntriesByType('resource')
        .filter((entry) => /chat\/completions|\/messages$/.test(entry.name)).length,
    }));
    return {
      protocol: name,
      ok,
      asked,
      baseline,
      oracle,
      submissions,
      screenshot: image,
      diagnostics,
      replyTail: state.transcript?.slice(-400) ?? '',
    };
  } finally {
    await context.close();
  }
}

export async function main() {
  const selected = selectProtocols(CONFIGS);
  if (!selected) {
    console.error(protocolSelectionError());
    process.exitCode = 2;
    return;
  }
  const key = process.env.OPENCODE_ACCESS_KEY;
  if (!key) {
    console.error('Missing OPENCODE_ACCESS_KEY');
    process.exitCode = 2;
    return;
  }
  const results = [];
  let failed = false;
  for (const entry of selected) {
    try {
      const summary = await runProtocol({ ...entry, key });
      results.push(summary);
      if (!summary.ok) failed = true;
      console.log(`${summary.ok ? 'Passed' : 'Failed'} ${entry.name}`);
    } catch (error) {
      failed = true;
      const message = error?.code === 'AA_CHECK' ? error.message : 'LIVE_CHECK_FAILED';
      results.push({ protocol: entry.name, ok: false, error: message });
      console.error(`Failed ${entry.name}: ${message}`);
    }
  }
  console.log(JSON.stringify({ model: MODEL, results }, null, 2));
  if (failed) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
