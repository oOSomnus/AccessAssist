import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXTENSION = path.resolve('extension');
export const PAGE_BASE = 'http://127.0.0.1:4173';
export const MOCK_BASE = 'http://127.0.0.1:4174';

function recordAnnouncements() {
  window.__aaAnnouncements = [];
  // The panel holds each message only long enough for a reader to speak it,
  // then clears the region. Real holds would push a queued sequence past these
  // tests' poll budgets, so shorten them; ordering is what the tests check.
  window.__aaSpeechHoldMs = 50;
  const install = () => {
    const element = document.getElementById('sr-status');
    if (!element) return false;
    const record = (node) => {
      const text = node?.textContent;
      if (text) window.__aaAnnouncements.push(text);
    };
    // One added node is one message. Removals are the panel clearing the
    // region after its hold, which is not an announcement.
    new MutationObserver((records) => {
      for (const mutation of records) {
        for (const node of mutation.addedNodes) record(node);
      }
    }).observe(element, { childList: true });
    record(element);
    return true;
  };
  if (install()) return;
  const timer = setInterval(() => { if (install()) clearInterval(timer); }, 10);
  setTimeout(() => clearInterval(timer), 5000);
}

function voiceStubs(options) {
  if (!location.protocol.startsWith('chrome-extension:')) return;
  const control = {
    available: options.available ?? 'available',
    installAccepted: options.installAccepted ?? true,
    installPending: options.installPending ?? false,
    permission: options.permission ?? 'granted',
    gum: options.gum ?? 'grant',
    audioRunning: options.audioRunning !== false,
    autoCue: options.autoCue !== false,
    cueMs: options.cueMs ?? 5,
    holdStart: options.holdStart ?? false,
    holdEnd: options.holdEnd ?? false,
    dropEnd: options.dropEnd ?? false,
    failStart: options.failStart ?? 0,
    echo: options.echo ?? 'all',
    installCalls: [],
    recognitions: [],
    nativeBusy: false,
    activeRecognition: null,
    starts: 0,
    ends: 0,
    aborts: 0,
    gumCalls: 0,
    gumOptions: [],
    tracksStopped: 0,
    speechStarts: 0,
    startArgs: [],
    lastTrack: null,
    events: [],
    cueNodes: [],
    tones: [],
    recognition: null,
  };
  window.__aaVoice = control;

  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.interimResults = true;
      this.continuous = true;
      this.maxAlternatives = 3;
      this.active = false;
      if (options.localSetterThrows) {
        let local;
        Object.defineProperty(this, 'processLocally', {
          configurable: true,
          get: () => local,
          set: (value) => {
            if (value === true) throw new Error('Local mode refused');
            local = value;
          },
        });
      } else {
        this.processLocally = undefined;
      }
      control.recognition = this;
      control.recognitions.push(this);
    }

    static available(args) {
      control.availableArgs = args;
      const value = control.available;
      return Promise.resolve(typeof value === 'function' ? value() : value);
    }

    static install(args) {
      control.installCalls.push(args);
      control.events.push('install');
      if (!args?.processLocally) return Promise.resolve(false);
      if (control.installPending) return new Promise(() => {});
      const value = control.installAccepted;
      return Promise.resolve(typeof value === 'function' ? value() : value).then((accepted) => {
        if (accepted === true) control.available = 'available';
        return accepted;
      });
    }

    start(track) {
      // The microphone is shared; a new instance cannot start while the
      // previous native session still holds it.
      if (this.active || control.nativeBusy) {
        throw Object.assign(new Error('recognition has already started'), { name: 'InvalidStateError' });
      }
      this.active = true;
      control.nativeBusy = true;
      control.activeRecognition = this;
      control.starts += 1;
      control.startArgs.push(track ?? null);
      control.events.push('start');
      if (control.failStart > 0) {
        // Model a throwing start that still holds the native recognizer.
        control.failStart -= 1;
        throw new Error('Unable to start recognition');
      }
      if (control.holdStart) return;
      queueMicrotask(() => {
        if (this.active) this.onstart?.();
      });
    }

    stop() {
      this.finish();
    }

    abort() {
      control.aborts += 1;
      control.events.push('abort');
      this.finish();
    }

    finish() {
      if (!this.active) return;
      // A held end keeps the native session active, like Chrome during a
      // delayed teardown; new starts still fail until releaseEnd runs.
      if (control.holdEnd) return;
      this.active = false;
      control.nativeBusy = false;
      // dropEnd models a released device whose end event was lost.
      if (control.dropEnd) return;
      control.ends += 1;
      queueMicrotask(() => this.onend?.());
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  class FakeAudioContext {
    constructor() {
      this.state = control.audioRunning ? 'running' : 'suspended';
      this.currentTime = 0;
      this.destination = {};
    }

    async resume() {
      if (control.audioRunning) this.state = 'running';
    }

    createOscillator() {
      const frequency = {
        _value: 0,
        get value() { return this._value; },
        set value(next) { this._value = next; control.tones.push(next); },
      };
      const oscillator = {
        frequency,
        onended: null,
        connect: (node) => node,
        start() {},
        stop() {},
      };
      control.cueNodes.push(oscillator);
      if (control.autoCue) {
        const finish = () => queueMicrotask(() => oscillator.onended?.());
        setTimeout(finish, control.cueMs);
      }
      return oscillator;
    }

    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (node) => node,
      };
    }
  }
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;

  control.endCue = () => {
    control.autoCue = true;
    for (const oscillator of control.cueNodes.splice(0)) oscillator.onended?.();
  };

  control.emit = (transcript, { final = true } = {}) => {
    const item = [{ transcript, confidence: 1 }];
    item.isFinal = final;
    control.recognition?.onresult?.({ results: [item], resultIndex: 0 });
  };
  control.emitResults = (items) => {
    const results = items.map(({ transcript, final = true }) => {
      const item = [{ transcript, confidence: 1 }];
      item.isFinal = final;
      return item;
    });
    control.recognition?.onresult?.({ results, resultIndex: 0 });
  };
  control.emitSpeechStart = () => {
    control.speechStarts += 1;
    control.events.push('speechstart');
    control.recognition?.onspeechstart?.();
  };
  control.emitNoSpeech = () => {
    const recognition = control.activeRecognition ?? control.recognition;
    recognition?.onerror?.({ error: 'no-speech' });
    if (recognition) recognition.active = false;
    control.nativeBusy = false;
    recognition?.onend?.();
  };
  control.emitEnd = () => {
    const recognition = control.activeRecognition ?? control.recognition;
    if (recognition) recognition.active = false;
    control.nativeBusy = false;
    recognition?.onend?.();
  };
  control.releaseStart = () => {
    const recognition = control.activeRecognition ?? control.recognition;
    if (recognition?.active) recognition.onstart?.();
  };
  control.releaseEnd = () => {
    const recognition = control.activeRecognition ?? control.recognition;
    if (!recognition) return;
    recognition.active = false;
    control.nativeBusy = false;
    control.activeRecognition = null;
    control.ends += 1;
    queueMicrotask(() => recognition.onend?.());
  };
  control.emitError = (error) => {
    control.recognition?.onerror?.({ error });
  };
  control.setPermission = (value) => {
    control.permission = value;
    control.permissionChange?.();
  };

  const getUserMedia = async (constraints) => {
    control.gumCalls += 1;
    control.gumOptions.push(constraints);
    control.events.push('gum');
    if (control.gum === 'pending') return new Promise(() => {});
    if (control.gum === 'deny') throw Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
    if (control.gum === 'missing') throw Object.assign(new Error('No microphone'), { name: 'NotFoundError' });
    control.permission = 'granted';
    // control.echo is what system-wide cancellation yields; a request for
    // Chrome's own canceller (macOS) gets exactly that.
    const requested = constraints?.audio?.echoCancellation;
    const settings = { echoCancellation: requested === true ? true : control.echo };
    const track = {
      kind: 'audio',
      readyState: 'live',
      onended: null,
      stop() { control.tracksStopped += 1; this.readyState = 'ended'; },
      getSettings: () => ({ ...settings }),
    };
    control.lastTrack = track;
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    return stream;
  };
  if (navigator.mediaDevices) {
    try {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: getUserMedia });
      // The host's real devices must not steer the scripted microphone.
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] });
    } catch {}
  }
  if (navigator.permissions) {
    const query = async (descriptor) => {
      if (descriptor?.name !== 'microphone') return { get state() { return 'prompt'; }, onchange: null };
      return {
        get state() { return control.permission; },
        get onchange() { return control.permissionChange; },
        set onchange(value) { control.permissionChange = value; },
      };
    };
    try {
      Object.defineProperty(navigator.permissions, 'query', { configurable: true, value: query });
    } catch {}
  }
}

export async function launch({ voice = null, deviceScaleFactor = 1, locale = 'en-US' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessassist-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    locale,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1000, height: 760 },
    deviceScaleFactor,
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await context.addInitScript(recordAnnouncements);
  // Every panel page gets the same deterministic microphone and cue stubs.
  await context.addInitScript(voiceStubs, voice ?? {});
  return { context, worker, extensionId, dir };
}

export async function openFixture(context, pathname) {
  const page = await context.newPage();
  await page.goto(`${PAGE_BASE}${pathname}`);
  await page.bringToFront();
  return page;
}

async function workerFor(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  return worker;
}

async function seedPanel(context, { protocol, baseUrl, apiKey = 'test-key' }) {
  const worker = await workerFor(context);
  const config = {
    protocol,
    baseUrl,
    model: 'deepseek-v4.1-flash',
    anthropicVersion: '2026-10-21',
  };
  const binding = { value: apiKey, origin: new URL(baseUrl).origin, at: Date.now() };
  await worker.evaluate(async ({ apiConfig, key }) => {
    const keys = ['apiConfig'];
    // Let the worker's own startup defaults settle before replacing them.
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const stored = await chrome.storage.local.get(keys);
      if (keys.every((name) => stored[name] !== undefined)) break;
      if (attempt === 149) throw new Error('Worker defaults did not initialize');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await chrome.storage.local.set({
      apiConfig,
      introSeen: true,
    });
    await chrome.storage.session.set({ apiKey: key });
    const stored = await chrome.storage.local.get(['apiConfig']);
    const session = await chrome.storage.session.get('apiKey');
    if (stored.apiConfig?.baseUrl !== apiConfig.baseUrl || stored.apiConfig?.protocol !== apiConfig.protocol) {
      throw new Error('Stored API configuration did not match the fixture');
    }
    if (session.apiKey?.origin !== key.origin) throw new Error('Stored key binding did not match the fixture');
  }, { apiConfig: config, key: binding });
}

export async function openPanel(context, extensionId, {
  protocol = 'openai',
  baseUrl = `${MOCK_BASE}/v1`,
  apiKey = 'test-key',
  seed = true,
} = {}) {
  if (seed) await seedPanel(context, { protocol, baseUrl, apiKey });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForSelector('#page-line');
  return panel;
}

export async function openFirstUsePanel(context, extensionId) {
  const worker = await workerFor(context);
  await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const stored = await chrome.storage.local.get('launcherPosition');
      if (stored.launcherPosition !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForSelector('#voice-setup', { state: 'attached' });
  return panel;
}

export async function announcements(panel) {
  return panel.evaluate(() => (window.__aaAnnouncements ?? []).join(' '));
}

export async function announcementEntries(panel) {
  return panel.evaluate(() => window.__aaAnnouncements ?? []);
}

export async function voiceState(panel) {
  return panel.evaluate(() => {
    const voice = window.__aaVoice;
    if (!voice) return null;
    return {
      available: typeof voice.available === 'function' ? voice.available() : voice.available,
      availableArgs: voice.availableArgs ?? null,
      installCalls: voice.installCalls,
      starts: voice.starts,
      ends: voice.ends,
      aborts: voice.aborts,
      recognitions: voice.recognitions.length,
      nativeBusy: voice.nativeBusy,
      gumCalls: voice.gumCalls,
      tracksStopped: voice.tracksStopped,
      events: voice.events,
      active: Boolean(voice.recognition?.active),
      processLocally: voice.recognition?.processLocally,
      permission: voice.permission,
      speechStarts: voice.speechStarts,
      tones: voice.tones,
      activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      startTrackKinds: voice.startArgs.map((track) => track?.kind ?? null),
      lastEcho: voice.lastTrack?.getSettings?.().echoCancellation ?? null,
      gumOptions: voice.gumOptions,
    };
  });
}

export async function emitFinal(panel, text) {
  await panel.evaluate((value) => window.__aaVoice.emit(value), text);
}

export async function emitResults(panel, items) {
  await panel.evaluate((value) => window.__aaVoice.emitResults(value), items);
}

export async function emitInterim(panel, text) {
  await panel.evaluate((value) => window.__aaVoice.emit(value, { final: false }), text);
}

export async function emitSpeechStart(panel) {
  await panel.evaluate(() => window.__aaVoice.emitSpeechStart());
}

export async function emitNoSpeech(panel) {
  await panel.evaluate(() => window.__aaVoice.emitNoSpeech());
}

export async function releaseStart(panel) {
  await panel.evaluate(() => window.__aaVoice.releaseStart());
}

export async function releaseEnd(panel) {
  await panel.evaluate(() => window.__aaVoice.releaseEnd());
}

export async function emitEnd(panel) {
  await panel.evaluate(() => window.__aaVoice.emitEnd());
}

export async function emitVoiceError(panel, error) {
  await panel.evaluate((value) => window.__aaVoice.emitError(value), error);
}

export async function endCue(panel) {
  await panel.evaluate(() => window.__aaVoice.endCue());
}

export async function setPermission(panel, value) {
  await panel.evaluate((state) => window.__aaVoice.setPermission(state), value);
}

// Models one claimed shortcut: the intent record is the authority; the
// broadcast is only a notification. `source` must be passed explicitly.
async function storeIntent(worker, intent) {
  return worker.evaluate(async (payload) => {
    const tabs = await chrome.tabs.query({});
    const page = tabs.find((candidate) => /^https?:/u.test(candidate.url ?? ''));
    if (!page) throw new Error('No HTTP page is open');
    const windowId = payload.windowId ?? page.windowId;
    const entry = {
      id: payload.id ?? crypto.randomUUID(),
      at: Date.now(),
      ...payload,
      windowId,
    };
    await chrome.storage.session.set({ [`intent:${windowId}`]: entry });
    return entry;
  }, intent);
}

export async function notifyIntent(worker, intent) {
  await worker.evaluate(
    (payload) => chrome.runtime.sendMessage({ type: 'ENTRY_INTENT', intent: payload }).catch(() => {}),
    intent,
  );
}

export async function sendIntent(worker, intent) {
  if (!intent?.source) throw new Error('sendIntent needs an explicit source');
  const entry = await storeIntent(worker, intent);
  await notifyIntent(worker, entry);
  return entry;
}

export async function seedIntent(worker, intent) {
  if (!intent?.source) throw new Error('seedIntent needs an explicit source');
  return storeIntent(worker, intent);
}

// Voice is the panel's only input: one Listen session carries the command.
// A programmatic click keeps the user's focus where the test put it.
export async function sendText(panel, text) {
  // The Listen label can appear before initializePanel finishes; clicks before
  // state.ready are dropped, so wait for the panel's own ready marker.
  await panel.locator('body[data-ready="true"]').waitFor({ state: 'attached' });
  await panel.locator('#listen', { hasText: '1 Listen' }).waitFor();
  await panel.evaluate(() => document.getElementById('listen').click());
  await panel.locator('#mode-line', { hasText: 'Listening. Speak now.' }).waitFor({ timeout: 15_000 });
  await emitFinal(panel, text);
}

export async function answer(panel, index) {
  const clicked = await panel.evaluate((position) => {
    const button = document.querySelectorAll('#ask-options button')[position];
    if (!button) return false;
    button.click();
    return true;
  }, index);
  expect(clicked).toBe(true);
}

export async function answerWhen(panel, questionPart, index = 0) {
  await expect(panel.locator('#ask-question')).toContainText(questionPart);
  await answer(panel, index);
}

// Undo is a composer action; it runs after the turn that made the change finishes.
export async function undoLastChange(panel) {
  await expect(panel.locator('#transcript')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  await panel.evaluate(() => document.getElementById('undo').click());
}

const DIAGNOSTIC_HEADERS = { 'x-aa-node-test': 'accessassist-fixtures' };

export async function resetMock() {
  await fetch(`${MOCK_BASE}/reset`, { method: 'POST', headers: DIAGNOSTIC_HEADERS });
}

export async function mockRequests() {
  const response = await fetch(`${MOCK_BASE}/requests`, { headers: DIAGNOSTIC_HEADERS });
  return response.json();
}

export async function transcriptText(panel) {
  return panel.locator('#transcript').textContent();
}
