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
  tab: null,
  frames: [],
  agent: null,
  attachError: null,
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
    get: async () => {
      if (behavior.tab) return behavior.tab;
      throw new Error('No such tab');
    },
    update: async () => {},
    sendMessage: async (tabId, message) => { calls.tabMessages.push({ tabId, message }); },
    onActivated: listener(),
    onRemoved: listener(),
    onUpdated: listener(),
  },
  webNavigation: {
    getAllFrames: async () => behavior.frames,
    getFrame: async () => behavior.frames[0] ?? null,
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
    attach: async () => {
      if (behavior.attachError) throw behavior.attachError;
    },
    detach: async () => {},
    sendCommand: async () => ({}),
    onEvent: { addListener() {}, removeListener() {} },
  },
  scripting: {
    executeScript: async (details) => (behavior.agent ? behavior.agent(details) : undefined),
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
  behavior.tab = null;
  behavior.frames = [];
  behavior.agent = null;
  behavior.attachError = null;
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

function panelMessage(message) {
  const sender = {
    id: 'test-extension',
    frameId: 0,
    url: 'chrome-extension://test-extension/sidepanel.html',
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
  assert.equal(notices()[0].intent.mode, 'open');
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
  assert.equal(entry.mode, 'open');

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

test('a local undo is marked as an execution', async () => {
  reset();
  behavior.tab = { id: 7, windowId: 3, active: true, url: 'https://example.test/page' };
  behavior.activeTabs = [behavior.tab];
  const response = await panelMessage({ type: 'UNDO_REQUEST', tabId: 7 });
  assert.deepEqual(response, { unavailable: true, reason: 'No action to undo' });
  // A worker killed mid-undo must be reported on restart, so the undo door
  // writes the same crash marker as a confirmed proposal.
  const markers = calls.sessionSet.filter((value) => 'executing:7' in value);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]['executing:7'].tabId, 7);
  assert.equal('executing:7' in behavior.sessionState, false);
});

// A page whose agent answers observe/state/setAlt, then fails every injection
// like a document that navigated under the worker.
function fakePage(tabId) {
  behavior.tab = { id: tabId, windowId: 3, active: true, title: 'Page', url: 'https://example.test/page' };
  behavior.activeTabs = [behavior.tab];
  behavior.frames = [{ frameId: 0, documentId: 'doc-1', url: 'https://example.test/page' }];
  const alts = new Map();
  let gone = false;
  const img = (nodeId) => ({
    nodeId, tag: 'img', role: 'img', name: `Image ${nodeId}`, visible: true, disabled: false,
    checkable: false, selectable: false, editable: false, focusable: false,
    checked: null, ariaChecked: null, value: null,
    alt: alts.get(nodeId) ?? { present: false, value: '' },
  });
  behavior.agent = async ({ args }) => {
    if (gone) throw new Error('Frame removed');
    if (!args) return [{ documentId: 'doc-1', result: true }];
    const payload = args[0];
    let result;
    if (payload.op === 'observe') {
      result = {
        snapshotId: 'abcdef01-snap', docToken: 'tok', title: 'Page',
        viewport: null, sections: [], targets: [img(1), img(2)], nextCursor: null,
      };
    } else if (payload.op === 'state') {
      result = { exists: true, docToken: 'tok', ...img(payload.nodeId) };
    } else if (payload.op === 'setAlt') {
      const after = { present: true, value: payload.alt };
      alts.set(payload.nodeId, after);
      gone = true;
      result = { before: { present: false, value: '' }, after };
    } else {
      throw new Error(`Unexpected agent op ${payload.op}`);
    }
    return [{ documentId: 'doc-1', result }];
  };
}

async function observeAndPropose(tabId) {
  const observed = await panelMessage({ type: 'OBSERVE_PAGE', tabId, expectedDocumentId: 'doc-1' });
  assert.equal(observed.error, undefined, JSON.stringify(observed));
  const proposed = await panelMessage({
    type: 'PROPOSE_ACTION',
    tabId,
    payload: {
      summary: 'Describe two images',
      steps: [
        { type: 'set_alt', id: 'abcdef01-1', alt: 'First' },
        { type: 'set_alt', id: 'abcdef01-2', alt: 'Second' },
      ],
    },
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(proposed.autoRun, true);
  return proposed.proposalId;
}

test('a step that throws mid-proposal keeps the completed step and its undo record', async () => {
  reset();
  fakePage(11);
  const proposalId = await observeAndPropose(11);
  const response = await panelMessage({ type: 'RUN_PROPOSAL', proposalId, tabId: 11 });

  assert.equal(response.report.completed, 1);
  assert.equal(response.report.failedStep, 'Step 2: The page changed; observe it again');
  assert.equal(response.report.undoKind, 'local');
  assert.equal(response.phase, 'awaiting_result_confirmation');
  const record = behavior.sessionState['undo:11'];
  assert.equal(record.fields.length, 1);
  assert.equal(record.fields[0].after.value, 'First');
});

test('a failure before any step reports nothing done and stores no undo record', async () => {
  reset();
  fakePage(12);
  behavior.attachError = new Error('Another debugger is attached');
  const proposalId = await observeAndPropose(12);
  const response = await panelMessage({ type: 'RUN_PROPOSAL', proposalId, tabId: 12 });

  assert.equal(response.report.completed, 0);
  assert.equal(response.report.failedStep, 'Could not connect to the page debugger: Another debugger is attached');
  assert.equal(response.report.undoKind, 'unavailable');
  assert.equal(response.phase, 'guide');
  assert.equal('undo:12' in behavior.sessionState, false);
});

test('the bound page is the web page on screen, never a hidden one', async () => {
  reset();
  const web = { id: 21, windowId: 5, active: true, title: 'Web', url: 'https://example.test/web' };
  behavior.tab = web;
  behavior.activeTabs = [web];
  behavior.frames = [{ frameId: 0, documentId: 'doc-21', url: web.url }];
  const first = await panelMessage({ type: 'GET_TAB_INFO', windowId: 5 });
  assert.equal(first.tabId, 21);
  // The user moves to a new tab page: the remembered web page is out of sight,
  // so nothing is bound rather than the page they left.
  behavior.activeTabs = [{ id: 22, windowId: 5, active: true, url: 'chrome://newtab/' }];
  const hidden = await panelMessage({ type: 'GET_TAB_INFO', windowId: 5 });
  assert.equal(hidden.tabId, undefined);
  assert.match(hidden.error, /cannot be read/u);
  assert.equal(hidden.title, 'chrome://newtab/');
});

test('the panel shown as a tab serves the last web page in its window', async () => {
  reset();
  const web = { id: 31, windowId: 6, active: true, title: 'Web', url: 'https://example.test/web' };
  behavior.tab = web;
  behavior.activeTabs = [web];
  behavior.frames = [{ frameId: 0, documentId: 'doc-31', url: web.url }];
  await panelMessage({ type: 'GET_TAB_INFO', windowId: 6 });
  behavior.tab = { ...web, active: false };
  behavior.activeTabs = [{ id: 32, windowId: 6, active: true, url: 'chrome-extension://test-extension/sidepanel.html' }];
  const info = await panelMessage({ type: 'GET_TAB_INFO', windowId: 6 });
  assert.equal(info.tabId, 31);
});

test('page requests for a tab that is no longer on screen are refused', async () => {
  reset();
  fakePage(41);
  const proposalId = await observeAndPropose(41);
  // The user switches to another web page in the same window.
  behavior.tab = { ...behavior.tab, active: false };
  behavior.activeTabs = [{ id: 42, windowId: 3, active: true, url: 'https://other.test/' }];
  for (const message of [
    { type: 'OBSERVE_PAGE', tabId: 41, expectedDocumentId: 'doc-1' },
    { type: 'READ_TARGET', tabId: 41, id: 'abcdef01-1' },
    { type: 'SCROLL_PAGE', tabId: 41, direction: 'down' },
    { type: 'RUN_PROPOSAL', tabId: 41, proposalId },
    { type: 'UNDO_REQUEST', tabId: 41 },
  ]) {
    const response = await panelMessage(message);
    assert.match(response.error ?? '', /no longer on screen/u, message.type);
  }
});

test('a cancel confirmation still reaches a page that is out of sight', async () => {
  reset();
  fakePage(51);
  const proposalId = await observeAndPropose(51);
  behavior.tab = { ...behavior.tab, active: false };
  behavior.activeTabs = [{ id: 52, windowId: 3, active: true, url: 'https://other.test/' }];
  const response = await panelMessage({
    type: 'CONFIRM_PROPOSAL', tabId: 51, proposalId, choiceSetId: 'set-x', optionValue: 'cancel',
  });
  assert.doesNotMatch(response.error ?? '', /no longer on screen/u);
});
