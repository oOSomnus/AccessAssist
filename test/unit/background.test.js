import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = {};
const calls = {
  close: [],
  open: [],
  messages: [],
  sessionSet: [],
  tabMessages: [],
  localSet: [],
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
  localState: {},
  localGetError: null,
  localSetError: null,
  holdLauncherGet: false,
  releaseLocalGet: null,
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
    sendMessage: async (tabId, message) => { calls.tabMessages.push({ tabId, message }); },
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
      get(key) {
        if (behavior.localGetError) {
          const error = behavior.localGetError;
          behavior.localGetError = null;
          return Promise.reject(error);
        }
        const names = typeof key === 'string'
          ? [key]
          : Array.isArray(key) ? key : Object.keys(key ?? {});
        const value = () => Object.fromEntries(
          names.filter((name) => name in behavior.localState).map((name) => [name, behavior.localState[name]]),
        );
        if (names.includes('launcherPosition') && behavior.holdLauncherGet) {
          behavior.holdLauncherGet = false;
          return new Promise((resolve) => { behavior.releaseLocalGet = () => resolve(value()); });
        }
        return Promise.resolve(value());
      },
      set(value) {
        if (behavior.localSetError) {
          const error = behavior.localSetError;
          behavior.localSetError = null;
          return Promise.reject(error);
        }
        calls.localSet.push(value);
        Object.assign(behavior.localState, value);
        return Promise.resolve();
      },
      remove: async (key) => {
        for (const name of typeof key === 'string' ? [key] : key) delete behavior.localState[name];
      },
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
  calls.tabMessages.length = 0;
  calls.localSet.length = 0;
  behavior.hangIntent = false;
  behavior.hangMessages = false;
  behavior.hangOpen = false;
  behavior.closeError = null;
  behavior.activeTabs = [];
  behavior.lastFocused = null;
  behavior.releaseIntent = null;
  behavior.releaseOpen = null;
  behavior.sessionState = {};
  behavior.localState = {};
  behavior.localGetError = null;
  behavior.localSetError = null;
  behavior.holdLauncherGet = false;
  behavior.releaseLocalGet = null;
}

async function settle() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function launcherMessage(message, senderOverrides = {}) {
  const sender = {
    id: 'test-extension',
    frameId: 0,
    url: 'https://example.test/page',
    tab: { id: 7, url: 'https://example.test/page' },
    ...senderOverrides,
  };
  return new Promise((resolve) => {
    let responded = false;
    const done = (value) => {
      if (responded) return;
      responded = true;
      resolve(value);
    };
    const keepOpen = listeners.message(message, sender, done);
    if (!keepOpen && !responded) done(undefined);
  });
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


test('legacy launcher corners migrate to normalized coordinates', async () => {
  reset();
  await settle();
  const corners = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 1, y: 1 } };
  for (const [legacy, expected] of Object.entries(corners)) {
    calls.localSet.length = 0;
    behavior.localState = { launcherPosition: legacy, apiConfig: { model: 'keep' }, unrelated: 1 };
    const response = await launcherMessage({ type: 'GET_LAUNCHER_STATE' });
    assert.deepEqual(response, { position: expected });
    assert.deepEqual(behavior.localState.launcherPosition, expected);
    assert.deepEqual(behavior.localState.apiConfig, { model: 'keep' });
    assert.equal(behavior.localState.unrelated, 1);
    assert.deepEqual(calls.localSet.map((value) => Object.keys(value)), [['launcherPosition']]);
    assert.deepEqual(calls.tabMessages, []);
  }
});

test('a stored launcher object is preserved and corrupt or missing values become the default', async () => {
  reset();
  await settle();
  behavior.localState = { launcherPosition: { x: 0.25, y: 0.75 } };
  assert.deepEqual(await launcherMessage({ type: 'GET_LAUNCHER_STATE' }), {
    position: { x: 0.25, y: 0.75 },
  });
  assert.deepEqual(calls.localSet, []);

  for (const launcherPosition of ['left', { x: '0.5', y: 0.5 }, { x: 0.5, y: 2 }, null]) {
    calls.localSet.length = 0;
    behavior.localState = { launcherPosition };
    assert.deepEqual(await launcherMessage({ type: 'GET_LAUNCHER_STATE' }), {
      position: { x: 1, y: 1 },
    });
    assert.deepEqual(behavior.localState.launcherPosition, { x: 1, y: 1 });
    assert.equal(calls.localSet.length, 1);
  }
  calls.localSet.length = 0;
  behavior.localState = {};
  assert.deepEqual(await launcherMessage({ type: 'GET_LAUNCHER_STATE' }), {
    position: { x: 1, y: 1 },
  });
  assert.equal(calls.localSet.length, 1);
});

test('launcher messages reject unauthorized senders without writing or broadcasting', async () => {
  reset();
  await settle();
  const stored = { launcherPosition: { x: 0.4, y: 0.6 } };
  const senders = [
    { id: 'other-extension' },
    { frameId: 1 },
    { tab: null },
    { tab: { id: 7 } },
    { url: 'chrome-extension://test-extension/sidepanel.html' },
    { tab: { id: 7, url: 'chrome-extension://test-extension/sidepanel.html' } },
    { url: 'about:blank' },
    { tab: { id: 7, url: 'https://example.test/page' }, url: 'about:blank' },
  ];
  for (const sender of senders) {
    behavior.localState = { ...stored };
    calls.localSet.length = 0;
    calls.tabMessages.length = 0;
    assert.deepEqual(await launcherMessage({ type: 'GET_LAUNCHER_STATE' }, sender), {
      error: 'Unauthorized launcher message',
    });
    assert.deepEqual(await launcherMessage({
      type: 'SET_LAUNCHER_POSITION', position: { x: 0.2, y: 0.3 },
    }, sender), { error: 'Unauthorized launcher message' });
    assert.deepEqual(behavior.localState.launcherPosition, stored.launcherPosition);
    assert.deepEqual(calls.localSet, []);
    assert.deepEqual(calls.tabMessages, []);
  }
});

test('malformed launcher positions never write or broadcast', async () => {
  reset();
  await settle();
  const stored = { x: 0.4, y: 0.6 };
  behavior.localState = { launcherPosition: stored };
  const values = [
    'br',
    null,
    [],
    { x: '0.5', y: 0.5 },
    { x: -0.1, y: 0.5 },
    { x: 0.5, y: 1.1 },
    { x: Number.NaN, y: 0.5 },
    { x: 0.5, y: Number.POSITIVE_INFINITY },
    { x: 0.5 },
  ];
  for (const position of values) {
    calls.localSet.length = 0;
    calls.tabMessages.length = 0;
    assert.deepEqual(await launcherMessage({ type: 'SET_LAUNCHER_POSITION', position }), {
      error: 'Invalid launcher position',
    });
    assert.deepEqual(behavior.localState.launcherPosition, stored);
    assert.deepEqual(calls.localSet, []);
    assert.deepEqual(calls.tabMessages, []);
  }
});

test('a valid launcher save stores one pair and broadcasts to other web tabs only', async () => {
  reset();
  await settle();
  behavior.localState = { launcherPosition: { x: 1, y: 1 } };
  behavior.activeTabs = [
    { id: 7, url: 'https://example.test/page' },
    { id: 8, url: 'https://example.test/other' },
    { id: 9, url: 'chrome-extension://test-extension/sidepanel.html' },
    { id: 10, url: 'ftp://example.test/file' },
  ];
  const response = await launcherMessage({
    type: 'SET_LAUNCHER_POSITION',
    position: { x: 0.375, y: 0.625, extra: 'drop' },
  });
  assert.deepEqual(response, { ok: true, position: { x: 0.375, y: 0.625 } });
  assert.deepEqual(behavior.localState.launcherPosition, { x: 0.375, y: 0.625 });
  const launcherWrites = calls.localSet.filter((value) => 'launcherPosition' in value);
  assert.deepEqual(launcherWrites, [{ launcherPosition: { x: 0.375, y: 0.625 } }]);
  assert.deepEqual(calls.tabMessages, [{
    tabId: 8,
    message: { type: 'SET_LAUNCHER_POSITION', position: { x: 0.375, y: 0.625 } },
  }]);
});

test('a failed launcher write reports the error, skips broadcasts and allows a later save', async () => {
  reset();
  await settle();
  const stored = { x: 0.1, y: 0.2 };
  behavior.localState = { launcherPosition: stored };
  behavior.localSetError = new Error('quota exceeded');
  assert.deepEqual(await launcherMessage({
    type: 'SET_LAUNCHER_POSITION', position: { x: 0.8, y: 0.9 },
  }), { error: 'Could not save the Assistant button position. Try again.' });
  assert.deepEqual(behavior.localState.launcherPosition, stored);
  assert.deepEqual(calls.tabMessages, []);

  assert.deepEqual(await launcherMessage({
    type: 'SET_LAUNCHER_POSITION', position: { x: 0.8, y: 0.9 },
  }), { ok: true, position: { x: 0.8, y: 0.9 } });
  assert.deepEqual(behavior.localState.launcherPosition, { x: 0.8, y: 0.9 });
});

test('a launcher read failure leaves storage alone and the queue still works', async () => {
  reset();
  await settle();
  const stored = { x: 0.3, y: 0.7 };
  behavior.localState = { launcherPosition: stored };
  behavior.localGetError = new Error('storage unavailable');
  assert.deepEqual(await launcherMessage({ type: 'GET_LAUNCHER_STATE' }), {
    error: 'Could not load the Assistant button position.',
  });
  assert.deepEqual(behavior.localState.launcherPosition, stored);
  assert.deepEqual(calls.localSet, []);

  behavior.localGetError = new Error('still unavailable');
  assert.deepEqual(await launcherMessage({
    type: 'SET_LAUNCHER_POSITION', position: { x: 0.6, y: 0.4 },
  }), { ok: true, position: { x: 0.6, y: 0.4 } });
  assert.deepEqual(behavior.localState.launcherPosition, { x: 0.6, y: 0.4 });
});

test('a queued launcher save wins over a delayed startup migration read', async () => {
  reset();
  await settle();
  behavior.localState = { launcherPosition: 'br' };
  behavior.holdLauncherGet = true;
  const pendingGet = launcherMessage({ type: 'GET_LAUNCHER_STATE' });
  for (let index = 0; index < 20 && !behavior.releaseLocalGet; index += 1) await Promise.resolve();
  assert.equal(typeof behavior.releaseLocalGet, 'function');
  const pendingSet = launcherMessage({
    type: 'SET_LAUNCHER_POSITION', position: { x: 0.2, y: 0.3 },
  });
  await settle();
  assert.deepEqual(behavior.localState.launcherPosition, 'br');
  behavior.releaseLocalGet();
  assert.deepEqual(await pendingGet, { position: { x: 1, y: 1 } });
  assert.deepEqual(await pendingSet, { ok: true, position: { x: 0.2, y: 0.3 } });
  assert.deepEqual(behavior.localState.launcherPosition, { x: 0.2, y: 0.3 });
});
