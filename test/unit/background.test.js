import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = {};
const calls = {
  close: [],
  open: [],
  messages: [],
  sessionSet: [],
};
const behavior = {
  hangIntent: false,
  hangMessages: false,
  hangOpen: false,
  closeError: null,
  activeTabs: [],
  lastFocused: null,
  releaseIntent: null,
  releaseOpen: null,
  sessionState: {},
};

const listener = () => ({ addListener() {} });

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onInstalled: listener(),
    onStartup: listener(),
    onMessage: { addListener(callback) { listeners.message = callback; } },
    sendMessage(message) {
      calls.messages.push(message);
      return behavior.hangMessages ? new Promise(() => {}) : Promise.resolve();
    },
  },
  commands: {
    onCommand: {
      addListener(callback) { listeners.command = callback; },
    },
  },
  tabs: {
    query: async () => behavior.activeTabs,
    get: async () => { throw new Error('No such tab'); },
    update: async () => {},
    sendMessage: async () => {},
    onActivated: listener(),
    onRemoved: listener(),
    onUpdated: listener(),
  },
  webNavigation: {
    onHistoryStateUpdated: listener(),
    onCommitted: listener(),
    onCreatedNavigationTarget: listener(),
  },
  windows: {
    getLastFocused: async () => behavior.lastFocused,
    update: async () => {},
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
      setAccessLevel: async () => {},
    },
    session: {
      get(key) {
        if (Array.isArray(key)) {
          return Promise.resolve(Object.fromEntries(
            key.filter((name) => name in behavior.sessionState)
              .map((name) => [name, behavior.sessionState[name]]),
          ));
        }
        return Promise.resolve(
          key in behavior.sessionState ? { [key]: behavior.sessionState[key] } : {},
        );
      },
      set(value) {
        calls.sessionSet.push(value);
        Object.assign(behavior.sessionState, value);
        if (behavior.hangIntent && Object.keys(value).some((key) => key.startsWith('intent:'))) {
          return new Promise((resolve) => { behavior.releaseIntent = resolve; });
        }
        return Promise.resolve();
      },
      remove: async (key) => { delete behavior.sessionState[key]; },
      setAccessLevel: async () => {},
    },
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    open(options) {
      calls.open.push(options);
      if (behavior.hangOpen) return new Promise((resolve) => { behavior.releaseOpen = resolve; });
      return Promise.resolve();
    },
    async close(options) {
      calls.close.push(options);
      if (behavior.closeError) throw behavior.closeError;
    },
  },
  debugger: {
    detach: async () => {},
  },
  scripting: {
    executeScript: async () => {},
  },
};

await import('../../extension/background.js');

function reset() {
  calls.close.length = 0;
  calls.open.length = 0;
  calls.messages.length = 0;
  calls.sessionSet.length = 0;
  behavior.hangIntent = false;
  behavior.hangMessages = false;
  behavior.hangOpen = false;
  behavior.closeError = null;
  behavior.activeTabs = [];
  behavior.lastFocused = null;
  behavior.releaseIntent = null;
  behavior.releaseOpen = null;
  behavior.sessionState = {};
}

test('a close command closes natively even when cleanup never settles', async () => {
  reset();
  behavior.hangIntent = true;
  behavior.hangMessages = true;
  await listeners.command('close-assistant', { windowId: 42, id: 7, url: 'https://example.test' });

  assert.deepEqual(calls.close, [{ windowId: 42 }]);
  assert.equal(calls.messages.filter((message) => message.type === 'CLOSE_PANEL').length, 1);
  assert.equal(calls.messages[0].windowId, 42);
  // A close never leaves an entry intent behind.
  assert.deepEqual(calls.sessionSet, []);
});

test('a close command without a tab uses the active window', async () => {
  reset();
  behavior.activeTabs = [{ id: 3, windowId: 9, url: 'https://example.test' }];
  await listeners.command('close-assistant', null);

  assert.deepEqual(calls.close, [{ windowId: 9 }]);
  assert.equal(calls.messages[0].type, 'CLOSE_PANEL');
  assert.equal(calls.messages[0].windowId, 9);
});

test('a rejected native close notifies only the target window', async () => {
  reset();
  behavior.closeError = new Error('blocked by the browser');
  await listeners.command('close-assistant', { windowId: 5, id: 8, url: 'https://example.test' });

  assert.deepEqual(calls.close, [{ windowId: 5 }]);
  const types = calls.messages.map((message) => message.type);
  assert.deepEqual(types, ['CLOSE_PANEL', 'PANEL_CLOSE_ERROR']);
  assert.deepEqual(calls.messages[1], {
    type: 'PANEL_CLOSE_ERROR',
    windowId: 5,
    error: 'blocked by the browser',
  });
  assert.equal(calls.messages.every((message) => message.windowId === 5), true);
  assert.deepEqual(calls.sessionSet, []);
});

test('a close command without a window does nothing', async () => {
  reset();
  await listeners.command('close-assistant', null);

  assert.deepEqual(calls.close, []);
  assert.deepEqual(calls.messages, []);
});

test('an open command broadcasts focus before native open or storage settle', async () => {
  reset();
  behavior.hangOpen = true;
  behavior.hangIntent = true;
  const running = listeners.command('open-assistant', { windowId: 42, id: 7, url: 'https://example.test' });

  const notices = () => calls.messages.filter((message) => message.type === 'ENTRY_INTENT');
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].intent.mode, 'typing');
  assert.equal(notices()[0].intent.source, 'command');
  assert.equal(notices()[0].intent.windowId, 42);
  assert.deepEqual(calls.open, [{ windowId: 42 }]);

  for (let index = 0; index < 50 && !(behavior.releaseIntent && behavior.releaseOpen); index += 1) {
    await Promise.resolve();
  }
  assert.equal(calls.sessionSet.length, 1);
  behavior.releaseIntent?.();
  behavior.releaseOpen?.();
  await running;
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  assert.equal(notices().length, 1);
});

test('the stored command intent is claimed exactly once', async () => {
  reset();
  await listeners.command('open-assistant', { windowId: 42, id: 7, url: 'https://example.test' });
  for (let index = 0; index < 20 && !calls.sessionSet.length; index += 1) await Promise.resolve();
  const stored = calls.sessionSet.find((value) => Object.keys(value).some((key) => key.startsWith('intent:')));
  assert.ok(stored, JSON.stringify(calls.sessionSet));
  const entry = stored['intent:42'];
  assert.equal(entry.mode, 'typing');

  const claim = () => new Promise((resolve) => {
    listeners.message(
      { type: 'CLAIM_INTENT', windowId: 42, intentId: entry.id },
      { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel.html' },
      resolve,
    );
  });
  const first = await claim();
  assert.equal(first.intent.id, entry.id);
  const second = await claim();
  assert.equal(second.intent, null);
});

