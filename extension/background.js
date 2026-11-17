// Service worker: the only context allowed to grant consent, use the debugger
// and run page actions. Page text and model output never carry authority here.
import {
  PHASE,
  acceptConsent,
  acceptResult,
  armConsent,
  armResult,
  createSession,
  finishExecution,
  observationDrift,
  pointsCrossMask,
  validateProposal,
} from './policy.js';
import { createExecutionQueue } from './execution.js';

const PANEL_URL = chrome.runtime.getURL('sidepanel.html');
const LAUNCHER_ID = 'accessassist-launcher-host';
const LAUNCHER_DEFAULT_POSITION = Object.freeze({ x: 1, y: 1 });
const LEGACY_LAUNCHER_POSITIONS = new Map([
  ['tl', { x: 0, y: 0 }],
  ['tr', { x: 1, y: 0 }],
  ['bl', { x: 0, y: 1 }],
  ['br', { x: 1, y: 1 }],
]);
const DEBUGGER_VERSION = '1.3';
const SETTLE_MS = 150;
const MAX_FIELD_VALUE = 65_536;
const NEW_PAGE_WINDOW_MS = 500;
const MAX_OPENED_TABS = 8;
const OPENED_TAB_TIMEOUT_MS = 5_000;
// Steps whose input can open a new tab through the page itself.
const OPENABLE_STEPS = new Set(['click', 'press_key', 'navigate', 'drag']);

const intents = new Map();
const lastHttpTab = new Map();
const observations = new Map();
const registry = new Map();
const proposals = new Map();
const undoRecords = new Map();
const executions = createExecutionQueue();
const notices = [];
const activeExecutions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function panelSender(sender) {
  return sender?.id === chrome.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(PANEL_URL);
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//iu.test(value);
}

let launcherPositionQueue = Promise.resolve();

function launcherSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender.frameId === 0
    && Number.isInteger(sender.tab?.id)
    && httpUrl(sender.url)
    && httpUrl(sender.tab?.url);
}

function isLauncherPosition(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1
    && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
}

function launcherPositionFrom(stored) {
  if (isLauncherPosition(stored)) return { position: { x: stored.x, y: stored.y }, current: true };
  return {
    position: LEGACY_LAUNCHER_POSITIONS.get(stored) ?? { ...LAUNCHER_DEFAULT_POSITION },
    current: false,
  };
}

async function migrateLauncherPosition() {
  const stored = await chrome.storage.local.get('launcherPosition');
  const { position, current } = launcherPositionFrom(stored.launcherPosition);
  if (!current) await chrome.storage.local.set({ launcherPosition: position });
  return position;
}

function queueLauncher(operation) {
  const run = launcherPositionQueue.then(operation, operation);
  launcherPositionQueue = run.catch(() => {});
  return run;
}

function modelUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Persistence, claims, and deletes share one queue so a slow write can never
// resurrect a consumed intent or let two panels claim the same one.
let intentQueue = Promise.resolve();

function intentTask(work) {
  const task = intentQueue.then(work, work);
  intentQueue = task.then(() => {}, () => {});
  return task;
}

function setIntent(windowId, intent) {
  const entry = { id: crypto.randomUUID(), at: Date.now(), ...intent, windowId };
  intents.set(windowId, entry);
  intentTask(() => chrome.storage.session.set({ [`intent:${windowId}`]: entry })).catch(() => {});
  return entry;
}

async function broadcastIntent(intent) {
  try {
    await chrome.runtime.sendMessage({ type: 'ENTRY_INTENT', intent });
  } catch {}
}

// `intentId` comes from a notification and must match exactly, so an outdated
// notice cannot delete a newer intent. Without it, a cold panel takes the
// newest stored intent for its own window.
async function claimIntent(windowId, intentId = null) {
  return intentTask(async () => {
    const local = intents.get(windowId) ?? null;
    const stored = await chrome.storage.session.get(`intent:${windowId}`).catch(() => ({}));
    const persisted = stored[`intent:${windowId}`] ?? null;
    const candidates = [local, persisted].filter(Boolean).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const intent = intentId ? candidates.find((entry) => entry.id === intentId) ?? null : candidates[0] ?? null;
    if (!intent) return null;
    if (local?.id === intent.id) intents.delete(windowId);
    if (persisted?.id === intent.id) await chrome.storage.session.remove(`intent:${windowId}`).catch(() => {});
    if (Date.now() - (intent.at ?? 0) > 60_000) return null;
    return intent;
  });
}

async function trackTab(tab) {
  if (tab && httpUrl(tab.url)) lastHttpTab.set(tab.windowId, { tabId: tab.id, at: Date.now() });
}

async function targetTab(tabId, windowId) {
  if (Number.isInteger(tabId)) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }
  if (!Number.isInteger(windowId)) return null;
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active && httpUrl(active.url)) return active;
  const remembered = lastHttpTab.get(windowId);
  if (remembered) {
    try {
      const tab = await chrome.tabs.get(remembered.tabId);
      if (httpUrl(tab.url) && tab.windowId === windowId) return tab;
    } catch {}
    lastHttpTab.delete(windowId);
  }
  // A restarted worker or a panel opened before any page event forgets the
  // last page; bind the window's most recently used web page instead.
  const tabs = await chrome.tabs.query({ windowId });
  const newest = tabs
    .filter((tab) => httpUrl(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
  if (!newest) return null;
  trackTab(newest);
  return newest;
}

function requireTab(tab) {
  if (!tab) throw new Error('No web page tab is available');
  if (!httpUrl(tab.url)) throw new Error('The current tab is not a regular web page and cannot be read or acted on');
  return tab;
}

function forgetTab(tabId) {
  for (const [snapshotId, entry] of registry) {
    if (entry.tabId === tabId) registry.delete(snapshotId);
  }
  observations.delete(tabId);
  for (const [id, entry] of proposals) {
    if (entry.tabId === tabId) proposals.delete(id);
  }
  detach(tabId);
}

async function injectLauncher(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['launcher.js'] });
  } catch {
    // Protected pages cannot host the launcher; shortcuts and the toolbar remain.
  }
}

async function migrateIntroState() {
  const stored = await chrome.storage.local.get(['introSeen', 'introCompleted']).catch(() => ({}));
  if (stored.introSeen === undefined && stored.introCompleted !== undefined) {
    await chrome.storage.local.set({ introSeen: stored.introCompleted === true }).catch(() => {});
  }
  if ('introCompleted' in stored) await chrome.storage.local.remove('introCompleted').catch(() => {});
}

async function initialize() {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await migrateIntroState();
  // Text output is system-reader-only now; old profiles must not revive TTS.
  await chrome.storage.local.remove('outputMode').catch(() => {});
  await queueLauncher(migrateLauncherPosition).catch(() => {});
  const stored = await chrome.storage.local.get('apiConfig').catch(() => ({}));
  const defaults = {};
  if (!stored.apiConfig) {
    defaults.apiConfig = {
      protocol: 'openai',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'deepseek-v4.1-flash',
      anthropicVersion: '2026-10-21',
      effort: 'default',
    };
  }
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults).catch(() => {});
  const executing = await chrome.storage.session.get('executing').catch(() => ({}));
  if (executing.executing) {
    notices.push('The last action was interrupted while executing; its result is unknown. Observe the page again before deciding.');
    await chrome.storage.session.remove('executing').catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) if (httpUrl(tab.url)) injectLauncher(tab.id);
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

async function commandWindowId(tab) {
  if (Number.isInteger(tab?.windowId)) return tab.windowId;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (Number.isInteger(active?.windowId)) return active.windowId;
  const last = await chrome.windows.getLastFocused().catch(() => null);
  return Number.isInteger(last?.id) ? last.id : null;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  // Closing is not an entry: it never opens the panel or leaves an intent.
  if (command === 'close-assistant') {
    const windowId = await commandWindowId(tab);
    if (!Number.isInteger(windowId)) return;
    // Cleanup must not gate the native close: intent storage and the panel
    // message can hang or have no receiver.
    void claimIntent(windowId).catch(() => null);
    void chrome.runtime.sendMessage({ type: 'CLOSE_PANEL', windowId }).catch(() => {});
    try {
      await chrome.sidePanel.close({ windowId });
    } catch (error) {
      console.warn('AccessAssist could not close the side panel', error);
      void chrome.runtime.sendMessage({
        type: 'PANEL_CLOSE_ERROR',
        windowId,
        error: error?.message ?? 'The side panel did not close.',
      }).catch(() => {});
    }
    return;
  }
  // Only the declared entry shortcuts create intents; only listen-once may
  // authorize a microphone session.
  const mode = command === 'open-assistant' ? 'open'
    : command === 'listen-once' ? 'voice'
      : command === 'replay-introduction' ? 'intro'
        : null;
  if (!mode) return;
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target) return;
  const intent = setIntent(target.windowId, { mode, source: 'command', tabId: target.id });
  // Notification and native opening are independent: a slow storage write or
  // sidePanel.open() must not delay the focus request the panel can act on.
  const opening = chrome.sidePanel.open({ windowId: target.windowId });
  const broadcasting = broadcastIntent(intent);
  await Promise.allSettled([opening, broadcasting]);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(trackTab).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  undoRecords.delete(tabId);
  chrome.storage.session.remove(`undo:${tabId}`).catch(() => {});
  for (const [windowId, entry] of lastHttpTab) if (entry.tabId === tabId) lastHttpTab.delete(windowId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId).then((tab) => {
    if (!httpUrl(tab.url)) return;
    lastHttpTab.set(tab.windowId, { tabId: tab.id, at: Date.now() });
    forgetTab(details.tabId);
  }).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId).then((tab) => {
    if (!httpUrl(tab.url)) return;
    lastHttpTab.set(tab.windowId, { tabId: tab.id, at: Date.now() });
    forgetTab(details.tabId);
  }).catch(() => {});
});

// Only a page opened by the input step that is currently running is attributed
// to the assistant; the panel asks the user before any page is adopted.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const execution = activeExecutions.get(details.sourceTabId);
  if (!execution || details.sourceFrameId !== execution.frameId) return;
  if (Number.isInteger(details.tabId)) execution.openedTabIds.add(details.tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // CLOSE_PANEL is addressed to the side-panel document, not to this worker.
  if (message?.type === 'CLOSE_PANEL') return false;
  if (message?.type === 'OPEN_ASSISTANT') {
    (async () => {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab) {
        return { error: 'Unauthorized launcher message' };
      }
      const tab = sender.tab;
      if (!httpUrl(tab.url)) return { error: 'The Assistant cannot be opened on this page' };
      const intent = setIntent(tab.windowId, { mode: 'voice', source: 'launcher', tabId: tab.id });
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      } catch (error) {
        return { error: `Could not open the side panel: ${error?.message ?? 'use the toolbar button instead'}` };
      }
      await broadcastIntent(intent);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (message?.type === 'COMPLETE_VOICE_SETUP') {
    (async () => {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) {
        return { error: 'Unauthorized setup message' };
      }
      if (sender.url !== `${PANEL_URL}?setup=1`) return { error: 'Unauthorized setup message' };
      let setupTab;
      try {
        setupTab = await chrome.tabs.get(sender.tab.id);
      } catch {
        return { error: 'The setup tab is gone. Open a web page, then open the assistant again.' };
      }
      const openerTabId = setupTab?.openerTabId;
      if (!Number.isInteger(openerTabId)) {
        return { error: 'Open a web page, then open the assistant again.' };
      }
      let opener;
      try {
        opener = await chrome.tabs.get(openerTabId);
      } catch {
        return { error: 'Open a web page, then open the assistant again.' };
      }
      if (!httpUrl(opener?.url) || opener.windowId !== setupTab.windowId) {
        return { error: 'Open a web page, then open the assistant again.' };
      }
      const intent = setIntent(setupTab.windowId, { mode: 'voice', source: 'setup', tabId: opener.id });
      await chrome.tabs.update(opener.id, { active: true }).catch(() => {});
      await chrome.windows.update(setupTab.windowId, { focused: true }).catch(() => {});
      await broadcastIntent(intent);
      return { ok: true, windowId: setupTab.windowId };
    })().then(sendResponse);
    return true;
  }
  if (message?.type === 'GET_LAUNCHER_STATE') {
    if (!launcherSender(sender)) {
      sendResponse({ error: 'Unauthorized launcher message' });
      return false;
    }
    queueLauncher(migrateLauncherPosition)
      .then((position) => sendResponse({ position }))
      .catch(() => sendResponse({ error: 'Could not load the Assistant button position.' }));
    return true;
  }
  if (message?.type === 'SET_LAUNCHER_POSITION') {
    if (!launcherSender(sender)) {
      sendResponse({ error: 'Unauthorized launcher message' });
      return false;
    }
    queueLauncher(() => setLauncherPosition(message.position, sender.tab.id))
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Could not save the Assistant button position. Try again.' }));
    return true;
  }
  if (!panelSender(sender)) {
    sendResponse({ error: 'Unauthorized message source' });
    return false;
  }
  route(message).then(sendResponse).catch((error) => {
    sendResponse({ error: error?.message ?? 'Action failed' });
  });
  return true;
});

let introClaimQueue = Promise.resolve();

async function claimIntroOnce() {
  const stored = await chrome.storage.local.get(['introSeen', 'introCompleted']);
  const seen = stored.introSeen === true || stored.introCompleted === true;
  if (stored.introSeen !== true) await chrome.storage.local.set({ introSeen: true });
  if ('introCompleted' in stored) await chrome.storage.local.remove('introCompleted');
  return { seen };
}

async function route(message) {
  switch (message.type) {
    case 'CLAIM_INTENT': {
      // The panel names its own window; a message without one cannot claim.
      if (!Number.isInteger(message.windowId)) return { intent: null, notices: [] };
      const intent = await claimIntent(message.windowId, message.intentId ?? null);
      return { intent, notices: message.cold === true ? notices.splice(0) : [] };
    }
    case 'CLAIM_INTRO': {
      const claim = introClaimQueue.then(claimIntroOnce, claimIntroOnce);
      introClaimQueue = claim.catch(() => {});
      return claim;
    }
    case 'GET_TAB_INFO': {
      const tab = await targetTab(message.tabId, message.windowId);
      if (!tab) return { error: 'No web page tab is available' };
      trackTab(tab);
      const documentId = await topDocument(tab.id).then((top) => top.documentId).catch(() => null);
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? '',
        url: modelUrl(tab.url),
        origin: originOf(tab.url),
        documentId,
        readable: httpUrl(tab.url),
      };
    }
    case 'GET_PAGE_ORIGINS': {
      const tab = requireTab(await targetTab(message.tabId));
      return pageOrigins(tab, message.expectedDocumentId);
    }
    case 'OBSERVE_PAGE': {
      const tab = requireTab(await targetTab(message.tabId));
      return observePage(
        tab,
        Array.isArray(message.allowedFrameOrigins) ? message.allowedFrameOrigins : [],
        { visual: message.visual === true, expectedDocumentId: message.expectedDocumentId, cursor: message.cursor },
      );
    }
    case 'READ_TARGET': return readTarget(requireTab(await targetTab(message.tabId)), message);
    case 'FOCUS_TARGET': return focusTarget(requireTab(await targetTab(message.tabId)), message);
    case 'SCROLL_PAGE': return scrollPage(requireTab(await targetTab(message.tabId)), message);
    case 'PROPOSE_ACTION': return proposeAction(requireTab(await targetTab(message.tabId)), message);
    case 'ARM_CONSENT': return armProposalConsent(message);
    case 'CONFIRM_PROPOSAL': return confirmProposal(requireTab(await targetTab(message.tabId)), message);
    case 'ARM_RESULT': return armProposalResult(message);
    case 'CONFIRM_RESULT': return confirmResult(message);
    case 'UNDO_REQUEST': return requestUndo(requireTab(await targetTab(message.tabId)));
    case 'CAPTURE_TARGET': return captureTarget(requireTab(await targetTab(message.tabId)), message);
    case 'ACTIVATE_TAB': return activateTab(message);
    case 'RESET_SESSION': return resetSession(message.tabId, { clearSnapshots: message.clearSnapshots === true });
    case 'GET_COMMANDS': return { commands: await chrome.commands.getAll() };
    default: return { error: 'Unknown message type' };
  }
}

const STALE_PAGE = 'The page changed; observe it again';
const REFUSE_CAPTURE = 'Screenshot unavailable: this page has embedded or sensitive areas that cannot be safely frozen.';

async function ensureAgent(tabId, frame) {
  if (!frame?.documentId) throw new Error(STALE_PAGE);
  const check = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] },
    world: 'ISOLATED',
    func: () => Boolean(globalThis.__accessAssistAgent?.version === 1),
  }).catch(() => {
    throw new Error(STALE_PAGE);
  });
  if (check?.[0]?.result) {
    if (check[0].documentId !== frame.documentId) throw new Error(STALE_PAGE);
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] },
    world: 'ISOLATED',
    files: ['page-agent.js'],
  }).catch(() => {
    throw new Error(STALE_PAGE);
  });
}

async function agentCall(tabId, frame, payload) {
  await ensureAgent(tabId, frame);
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] },
    world: 'ISOLATED',
    func: (data) => globalThis.__accessAssistAgent.handle(data),
    args: [payload],
  }).catch(() => {
    throw new Error(STALE_PAGE);
  });
  const outcome = results?.[0];
  if (!outcome || outcome.documentId !== frame.documentId) throw new Error(STALE_PAGE);
  return outcome.result;
}

// Frame metadata is the authority for which document a frame ID currently
// shows. Missing document identity fails closed; it is never guessed.
async function framesFor(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    throw new Error(STALE_PAGE);
  }
  if (!frames?.length) throw new Error(STALE_PAGE);
  return frames.map((frame) => ({ ...frame }));
}

async function topDocument(tabId) {
  let top;
  try {
    top = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  } catch {
    throw new Error(STALE_PAGE);
  }
  if (!top?.documentId) throw new Error(STALE_PAGE);
  return top;
}

function pinnedTop(frames, expectedDocumentId) {
  const top = frames.find((frame) => frame.frameId === 0);
  if (!top?.documentId || !expectedDocumentId || top.documentId !== expectedDocumentId) {
    throw new Error(STALE_PAGE);
  }
  return top;
}

// Metadata only: the panel may list sources before any frame text is read.
async function pageOrigins(tab, expectedDocumentId) {
  const pageOrigin = originOf(tab.url);
  if (!httpUrl(tab.url) || !pageOrigin) throw new Error('Page address is unavailable');
  const frames = (await framesFor(tab.id)).slice().sort((left, right) => left.frameId - right.frameId);
  const top = pinnedTop(frames, expectedDocumentId);
  const seen = new Set([pageOrigin]);
  const frameOrigins = [];
  for (const frame of frames) {
    if (frame.frameId === 0 || !httpUrl(frame.url)) continue;
    const origin = originOf(frame.url);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    frameOrigins.push(origin);
  }
  return {
    tabId: tab.id, url: modelUrl(tab.url), origin: pageOrigin, frameOrigins,
    documentId: top.documentId,
  };
}

function modelTarget(entry, target) {
  return {
    snapshotId: entry.snapshotId,
    frameId: entry.frameId,
    nodeId: target.nodeId,
    kind: target.kind ?? 'native-control',
    capabilities: target.capabilities ?? null,
    focusable: target.focusable === true,
    focused: target.focused === true,
    role: target.role,
    name: target.name,
    tag: target.tag,
    type: target.type,
    disabled: target.disabled,
    visible: target.visible,
    inViewport: target.inViewport,
    editable: target.editable,
    readOnly: target.readOnly === true,
    contentEditable: target.contentEditable === true,
    checkable: target.checkable,
    selectable: target.selectable,
    submits: target.submits,
    link: target.link ? modelUrl(target.link) : null,
    alt: target.alt,
    value: target.value,
    checked: target.checked,
    ariaChecked: target.ariaChecked,
    ariaSelected: target.ariaSelected,
    ariaExpanded: target.ariaExpanded,
    ariaPressed: target.ariaPressed,
    styleState: target.styleState ?? null,
    near: target.near ?? null,
    docToken: target.docToken ?? null,
    selected: target.selected,
    options: target.options,
    rect: {
      x: Math.round(target.rect.x), y: Math.round(target.rect.y),
      width: Math.round(target.rect.width), height: Math.round(target.rect.height),
    },
  };
}

async function observePage(tab, allowedOrigins, { visual = false, expectedDocumentId, cursor } = {}) {
  const frames = (await framesFor(tab.id)).slice().sort((a, b) => a.frameId - b.frameId);
  const top = pinnedTop(frames, expectedDocumentId);
  const topOrigin = originOf(top.url);
  if (!httpUrl(top.url) || !topOrigin) throw new Error('Page address is unavailable');
  const allowed = new Set(allowedOrigins);
  const sections = [];
  const targets = [];
  const blockedFrames = [];
  const blockedIds = [];
  const texts = [];
  let merged = null;
  let mergedVisual = null;
  let visualNodeId = null;

  for (const frame of frames) {
    if (frame.frameId !== 0 && !httpUrl(frame.url)) {
      if (!blockedFrames.includes('an embedded area')) blockedFrames.push('an embedded area');
      blockedIds.push(frame.frameId);
      continue;
    }
    const origin = originOf(frame.url);
    const sameOrigin = origin && topOrigin && origin === topOrigin;
    if (frame.frameId !== 0 && !sameOrigin && !allowed.has(origin)) {
      if (!blockedFrames.includes(origin)) blockedFrames.push(origin);
      blockedIds.push(frame.frameId);
      continue;
    }
    if (!frame.documentId) {
      const blocked = originOf(frame.url) ?? 'an embedded area';
      if (!blockedFrames.includes(blocked)) blockedFrames.push(blocked);
      blockedIds.push(frame.frameId);
      continue;
    }
    let observation;
    try {
      observation = await agentCall(tab.id, frame, {
        op: 'observe',
        visual: visual && frame.frameId === 0,
        cursor: frame.frameId === 0 ? cursor : undefined,
      });
    } catch (error) {
      if (frame.frameId === 0) throw new Error(`Could not read the page: ${error?.message ?? 'script injection failed'}`);
      if (!blockedFrames.includes(origin)) blockedFrames.push(origin ?? 'an embedded area');
      blockedIds.push(frame.frameId);
      continue;
    }
    if (observation?.error) {
      if (frame.frameId === 0) throw new Error(observation.error);
      if (!blockedFrames.includes(origin)) blockedFrames.push(origin ?? 'an embedded area');
      blockedIds.push(frame.frameId);
      continue;
    }
    const entry = {
      tabId: tab.id,
      frameId: frame.frameId,
      documentId: frame.documentId,
      snapshotId: observation.snapshotId,
      docToken: observation.docToken,
      createdAt: Date.now(),
      targets: new Map(),
    };
    registry.set(observation.snapshotId, entry);
    while (registry.size > 100) registry.delete(registry.keys().next().value);
    const label = frame.frameId === 0 ? null : `Region ${origin}${new URL(frame.url).pathname}`;
    for (const section of observation.sections ?? []) {
      sections.push({
        name: label && section.name === 'Body' ? label : section.name,
        items: section.items.map((item) => ({ ...item, frameId: frame.frameId })),
      });
    }
    for (const target of observation.targets ?? []) {
      const meta = { ...target, tabId: tab.id, frameId: frame.frameId, snapshotId: observation.snapshotId };
      entry.targets.set(target.nodeId, meta);
      targets.push(modelTarget(entry, target));
      texts.push(target.name ?? '');
      if (target.near?.above?.text) texts.push(target.near.above.text);
      if (target.near?.left?.text) texts.push(target.near.left.text);
    }
    for (const section of observation.sections ?? []) {
      for (const item of section.items) texts.push(`${item.name} ${item.text}`);
    }
    if (frame.frameId === 0 && observation.visual) {
      mergedVisual = observation.visual;
      visualNodeId = observation.visual.nodeId;
    }
    merged ??= observation;
  }

  const record = {
    docToken: merged?.docToken ?? null,
    documentId: top.documentId,
    pageText: texts.join('\n').slice(0, 60000),
    title: tab.title ?? merged?.title ?? '',
    url: tab.url,
    viewport: merged?.viewport ?? null,
    at: Date.now(),
    blocked: blockedIds,
    visual: null,
  };
  observations.set(tab.id, record);

  const result = {
    snapshotId: merged?.snapshotId ?? null,
    title: merged?.title ?? tab.title ?? '',
    url: modelUrl(tab.url),
    viewport: merged?.viewport ?? null,
    sections,
    targets,
    nextCursor: merged?.nextCursor ?? null,
    blockedFrames,
    visual: null,
  };
  if (!visual || !mergedVisual) return result;

  if (!Number.isInteger(visualNodeId)) {
    return { ...result, visual: { allowed: false, error: 'The visual area could not be registered; observe again' } };
  }
  const capture = await captureViewport(tab, mergedVisual, { expectedDocumentId: top.documentId });
  if (capture.error) return { ...result, visual: { allowed: false, error: capture.error } };
  const settled = await agentCall(tab.id, top, {
    op: 'state', snapshotId: merged.snapshotId, nodeId: visualNodeId,
  }).catch(() => null);
  if (!settled?.exists || settled.docToken !== merged.docToken
    || settled.scrollX !== capture.scroll.x || settled.scrollY !== capture.scroll.y) {
    return { ...result, visual: { allowed: false, error: 'The page moved while the screenshot was taken; observe again' } };
  }
  const metadata = {
    allowed: true,
    nodeId: visualNodeId,
    snapshotId: merged.snapshotId,
    frameId: 0,
    viewport: capture.viewport,
    scroll: capture.scroll,
    pixel: { width: capture.width, height: capture.height },
    scale: capture.scale,
    pixels: capture.pixels,
    fingerprint: capture.fingerprint,
    createdAt: Date.now(),
  };
  record.visual = metadata;
  const entry = registry.get(merged.snapshotId);
  if (entry) entry.visual = metadata;
  const visualTarget = entry?.targets.get(visualNodeId);
  if (visualTarget) {
    visualTarget.kind = 'visual-region';
    visualTarget.visual = metadata;
  }
  const { fingerprint, pixels, ...visible } = metadata;
  return { ...result, visual: { ...visible, dataUrl: capture.dataUrl } };
}

function invalidateVisual(tabId) {
  const record = observations.get(tabId);
  if (record) record.visual = null;
  for (const entry of registry.values()) {
    if (entry.tabId !== tabId || !entry.visual) continue;
    entry.visual = null;
    for (const [nodeId, target] of entry.targets) {
      if (target.kind === 'visual-region') entry.targets.delete(nodeId);
    }
  }
}

function registryTarget(snapshotId, nodeId) {
  const entry = registry.get(snapshotId);
  if (!entry) return null;
  const target = entry.targets.get(nodeId);
  return target ? { entry, target } : null;
}

async function readTarget(tab, message) {
  const found = registryTarget(message.snapshotId, message.nodeId);
  if (!found || found.entry.tabId !== tab.id) return { error: 'Observe the page again first' };
  const result = await agentCall(tab.id, found.entry, {
    op: 'read', snapshotId: message.snapshotId, nodeId: message.nodeId, cursor: message.cursor,
  });
  if (result?.error) return { error: result.error };
  return { name: result.name, role: result.role, text: result.text, nextCursor: result.nextCursor };
}

async function focusTarget(tab, message) {
  const found = registryTarget(message.snapshotId, message.nodeId);
  if (!found || found.entry.tabId !== tab.id) return { error: 'Observe the page again first' };
  try {
    const result = await agentCall(tab.id, found.entry, {
      op: 'focus', snapshotId: message.snapshotId, nodeId: message.nodeId,
    });
    if (result?.error) return { error: result.error };
    return { ok: true };
  } finally {
    // Focus can scroll; older screenshot coordinates may no longer match.
    invalidateVisual(tab.id);
  }
}

async function scrollPage(tab, message) {
  if (!['up', 'down', 'left', 'right'].includes(message.direction)) {
    return { error: 'Unsupported scroll direction' };
  }
  const hasSnapshot = message.snapshotId !== undefined;
  const hasNode = message.nodeId !== undefined;
  if (hasSnapshot !== hasNode) return { error: 'Scrolling a region needs both a snapshot and a target' };
  if (!hasSnapshot) {
    const record = observations.get(tab.id);
    if (!record?.documentId) return { error: STALE_PAGE };
    const result = await agentCall(tab.id, { frameId: 0, documentId: record.documentId }, {
      op: 'scroll', direction: message.direction,
    });
    if (result?.error) return { error: result.error };
    invalidateVisual(tab.id);
    return {
      ok: true,
      moved: result.moved === true,
      scrollX: result.scrollX,
      scrollY: result.scrollY,
      scrollLeft: result.scrollLeft ?? null,
      scrollTop: result.scrollTop ?? null,
    };
  }
  const found = registryTarget(message.snapshotId, message.nodeId);
  if (!found || found.entry.tabId !== tab.id) return { error: 'Observe the page again first' };
  const state = await agentCall(tab.id, found.entry, {
    op: 'state', snapshotId: message.snapshotId, nodeId: message.nodeId,
  });
  if (state?.error) return { error: state.error };
  if (!state?.exists) return { error: 'Target no longer exists; observe the page again' };
  if (!state.visible || !state.inViewport) return { error: 'Scroll to the target first, then observe it again' };
  if (state.docToken !== found.entry.docToken) return { error: 'The page changed; observe it again' };
  const result = await agentCall(tab.id, found.entry, {
    op: 'scroll', direction: message.direction, snapshotId: message.snapshotId, nodeId: message.nodeId,
  });
  invalidateVisual(tab.id);
  if (result?.error) return { error: result.error };
  return {
    ok: true,
    moved: result.moved === true,
    scrollX: result.scrollX,
    scrollY: result.scrollY,
    scrollLeft: result.scrollLeft ?? null,
    scrollTop: result.scrollTop ?? null,
  };
}

function currentTargets(tabId) {
  const map = new Map();
  for (const entry of registry.values()) {
    if (entry.tabId !== tabId) continue;
    for (const [nodeId, target] of entry.targets) {
      map.set(`${entry.snapshotId}:${nodeId}`, {
        ...target,
        frameId: entry.frameId,
        snapshotId: entry.snapshotId,
        link: target.link ? target.link : null,
        modelLink: target.link ? modelUrl(target.link) : null,
        documentId: entry.documentId,
      });
    }
  }
  return map;
}

async function expectedState(step, entry, { fullValue = false } = {}) {
  const state = await agentCall(entry.tabId, entry, {
    op: 'state', snapshotId: step.snapshotId, nodeId: step.nodeId,
    includeHash: step.type === 'click' || step.type === 'drag', fullValue,
  });
  if (state?.error) return { error: state.error };
  return { state };
}

function comparable(state) {
  return {
    docToken: state.docToken,
    disabled: state.disabled,
    visible: state.visible,
    name: state.name,
    role: state.role,
    tag: state.tag,
    link: state.link,
    value: state.value,
    checked: state.checked,
    ariaChecked: state.ariaChecked,
    ariaSelected: state.ariaSelected,
    styleState: state.styleState ?? null,
    selected: state.selected,
    alt: state.alt,
    rect: state.rect
      ? { x: Math.round(state.rect.x), y: Math.round(state.rect.y), width: Math.round(state.rect.width), height: Math.round(state.rect.height) }
      : null,
  };
}

async function proposeAction(tab, message) {
  const observation = observations.get(tab.id);
  if (!observation) return { ok: false, errors: ['Observe the page first'] };
  const session = createSession();
  const documentIds = new Map();
  for (const entry of registry.values()) {
    if (entry.tabId === tab.id) documentIds.set(entry.frameId, entry.docToken);
  }
  const context = {
    tabId: tab.id,
    windowId: tab.windowId,
    documentId: observation.docToken,
    documentIds,
    url: modelUrl(tab.url),
    userText: String(message.userText ?? ''),
    pageText: observation.pageText,
    confirmedChoices: new Set(Array.isArray(message.confirmedChoices) ? message.confirmedChoices : []),
    targets: currentTargets(tab.id),
    now: Date.now(),
  };
  const outcome = validateProposal(message.payload, context);
  if (!outcome.ok) {
    return {
      ok: false,
      errors: outcome.errors,
      needsClarification: Boolean(outcome.needsClarification),
      message: outcome.needsClarification ? 'Required information is incomplete; use ask_user to clarify first' : 'Invalid proposal',
    };
  }
  if (outcome.needsClarification) {
    return {
      ok: false,
      needsClarification: true,
      errors: outcome.proposal.missingFields.length ? outcome.proposal.missingFields : outcome.errors,
      message: 'Required information is incomplete; use ask_user to clarify first',
    };
  }
  const expected = new Map();
  for (const step of outcome.proposal.steps) {
    const entry = registry.get(step.snapshotId);
    if (!entry || entry.tabId !== tab.id) return { ok: false, errors: ['Snapshot expired; observe the page again'] };
    const state = await expectedState(step, entry, { fullValue: step.type === 'set_value' });
    if (!state.state?.exists) return { ok: false, errors: ['Target no longer exists; observe the page again'] };
    const drift = observationDrift(step, state.state, entry.targets.get(step.nodeId));
    if (drift) return { ok: false, errors: [`The page changed since it was observed (${drift}); observe the page again`] };
    expected.set(`${step.snapshotId}:${step.nodeId}`, comparable(state.state));
    if (step.toNodeId !== undefined) {
      const end = await agentCall(tab.id, entry, {
        op: 'state', snapshotId: step.snapshotId, nodeId: step.toNodeId,
      });
      if (!end?.exists) return { ok: false, errors: ['Drag endpoint no longer exists; observe the page again'] };
      const endDrift = observationDrift(step, end, entry.targets.get(step.toNodeId));
      if (endDrift) return { ok: false, errors: [`The page changed since it was observed (${endDrift}); observe the page again`] };
      expected.set(`${step.snapshotId}:${step.toNodeId}`, comparable(end));
    }
  }
  const proposal = { ...outcome.proposal, tabId: tab.id, windowId: tab.windowId, expected };
  const stored = {
    ...session,
    phase: PHASE.consent,
    proposal,
  };
  proposals.set(proposal.id, { session: stored, tabId: tab.id });
  return {
    ok: true,
    proposalId: proposal.id,
    summary: proposal.summary,
    risk: proposal.risk,
    undoKind: proposal.undoKind,
    stepCount: proposal.steps.length,
  };
}

function armProposalConsent(message) {
  const stored = proposals.get(message.proposalId);
  if (!stored) return { error: 'Proposal expired; propose it again' };
  const outcome = armConsent(stored.session, { choiceSetId: message.choiceSetId });
  if (outcome.error) return { error: outcome.error };
  proposals.set(message.proposalId, { ...stored, session: outcome.session });
  return { ok: true };
}

function armProposalResult(message) {
  const stored = proposals.get(message.proposalId);
  if (!stored) return { error: 'Result confirmation expired' };
  const outcome = armResult(stored.session, { choiceSetId: message.choiceSetId });
  if (outcome.error) return { error: outcome.error };
  proposals.set(message.proposalId, { ...stored, session: outcome.session });
  return { ok: true };
}

function confirmResult(message) {
  const stored = proposals.get(message.proposalId);
  if (!stored) return { error: 'Result confirmation expired' };
  const outcome = acceptResult(stored.session, {
    choiceSetId: message.choiceSetId, optionValue: message.optionValue,
  });
  if (outcome.error) return { error: outcome.error };
  proposals.delete(message.proposalId);
  return { ok: true, action: outcome.action };
}

async function confirmProposal(tab, message) {
  const stored = proposals.get(message.proposalId);
  if (!stored) return { error: 'Confirmation expired; propose the action again' };
  if (stored.tabId !== tab.id) return { error: 'The page changed; propose the action again' };
  const outcome = acceptConsent(stored.session, {
    choiceSetId: message.choiceSetId, optionValue: message.optionValue,
  });
  if (outcome.error) return { error: outcome.error };
  proposals.set(message.proposalId, { ...stored, session: outcome.session });
  if (outcome.action === 'cancel') {
    proposals.delete(message.proposalId);
    return { ok: true, action: 'cancel' };
  }
  if (outcome.action === 'risk') return { ok: true, action: 'risk' };

  const proposal = outcome.session.proposal;
  let report;
  let stopped = false;
  try {
    const run = await executions.run(tab.id, async () => {
      await chrome.storage.session.set({
        executing: { proposalId: proposal.id, tabId: tab.id, at: Date.now() },
      }).catch(() => {});
      try {
        return await executeProposal(tab, proposal);
      } finally {
        await chrome.storage.session.remove('executing').catch(() => {});
      }
    });
    report = run.value;
    stopped = run.stopped;
  } catch (error) {
    report = { completed: 0, failedStep: error?.message ?? 'Execution failed', verified: false, record: null };
  }
  const finished = finishExecution(outcome.session, {
    completedSteps: report.completed,
    failedStep: report.failedStep,
    verified: report.verified,
    changed: report.changed ?? report.verified,
    undoKind: report.record?.undoKind ?? 'unavailable',
  });
  // A reset during execution owns the tab now; do not revive the old proposal.
  if (stopped) proposals.delete(message.proposalId);
  else proposals.set(message.proposalId, { ...stored, session: finished.session });
  if (finished.phase !== PHASE.result || proposal.isUndo) proposals.delete(message.proposalId);
  return {
    ok: true,
    action: 'execute',
    report: {
      summary: proposal.summary,
      completed: report.completed,
      failedStep: report.failedStep ?? null,
      verified: report.verified,
      changed: report.changed ?? report.verified,
      undoKind: report.record?.undoKind ?? 'unavailable',
      details: report.details ?? [],
      openedTabs: report.record?.openedTabs ?? [],
      openedTabsOverflow: report.record?.openedTabsOverflow === true,
    },
    phase: finished.phase,
  };
}

function compareExpected(step, state, expected) {
  if (!expected) return null;
  const current = comparable(state);
  // Raw class/style text is excluded: CSSOM serialization can change while the
  // rendered target stays identical. Computed styleState, geometry, semantic
  // state, and the hit test still catch real moves, recolors, and overlays.
  // A screenshot point is anchored to frozen pixels and re-hit-tested, not to
  // the synthetic visual region's own geometry.
  const keys = step.point || step.points
    ? ['docToken', 'visible']
    : ['docToken', 'visible', 'disabled', 'name', 'role', 'tag', 'link', 'value', 'checked', 'ariaChecked', 'ariaSelected', 'styleState', 'alt', 'rect'];
  for (const key of keys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(expected[key])) return `Page state changed (${key}); observe the page again`;
  }
  if (!step.point && !step.points && JSON.stringify(current.selected) !== JSON.stringify(expected.selected)) {
    return 'Page state changed; observe the page again';
  }
  return null;
}

async function executeProposal(tab, proposal) {
  if (executions.stopped(tab.id)) {
    return {
      completed: 0,
      failedStep: 'The page was reset before this action started; nothing was executed',
      verified: false,
      changed: false,
      record: null,
      details: [],
    };
  }
  const record = {
    transactionId: crypto.randomUUID(),
    tabId: tab.id,
    summary: proposal.summary,
    undoKind: proposal.undoKind,
    isUndo: Boolean(proposal.isUndo),
    fields: [],
    clicks: [],
    urlBefore: tab.url,
    openedTabs: [],
    openedTabsOverflow: false,
    createdAt: Date.now(),
  };
  const details = [];
  let cdp = null;
  let completed = 0;
  let failedStep = null;
  let verified = true;
  let changed = false;
  try {
    cdp = await debuggerSession(tab.id);
    await setLauncherHidden(cdp, true);
    for (const [index, step] of proposal.steps.entries()) {
      if (executions.stopped(tab.id)) {
        failedStep = 'The user left or reset the page; remaining steps were not executed';
        break;
      }
      const entry = registry.get(step.snapshotId);
      if (!entry || entry.tabId !== tab.id) {
        failedStep = `Step ${index + 1}: observe the page again`;
        break;
      }
      const fullValue = step.type === 'set_value';
      const stateResult = await agentCall(tab.id, entry, {
        op: 'state', snapshotId: step.snapshotId, nodeId: step.nodeId, includeHash: true, fullValue,
      });
      if (!stateResult?.exists) {
        failedStep = `Step ${index + 1}: target no longer exists`;
        break;
      }
      const expected = proposal.expected?.get(`${step.snapshotId}:${step.nodeId}`);
      const stale = compareExpected(step, stateResult, expected);
      if (stale) {
        failedStep = `Step ${index + 1}: ${stale}`;
        break;
      }
      const endExpected = step.toNodeId === undefined
        ? null
        : proposal.expected?.get(`${step.snapshotId}:${step.toNodeId}`);
      if (endExpected) {
        const endState = await agentCall(tab.id, entry, {
          op: 'state', snapshotId: step.snapshotId, nodeId: step.toNodeId,
        });
        const endStale = endState?.exists ? compareExpected(step, endState, endExpected) : 'Page state changed; observe the page again';
        if (endStale) {
          failedStep = `Step ${index + 1}: ${endStale}`;
          break;
        }
      }
      const openable = OPENABLE_STEPS.has(step.type);
      if (openable) {
        activeExecutions.set(tab.id, {
          proposalId: proposal.id,
          frameId: entry.frameId,
          openedTabIds: new Set(),
        });
      }
      let outcome;
      try {
        outcome = await executeStep(tab, step, entry, stateResult, cdp, record);
      } catch (error) {
        outcome = { ok: false, error: error?.message ?? 'Execution failed' };
      } finally {
        // Scrolling, focus, or a click can move the pixels a screenshot mapped.
        invalidateVisual(tab.id);
      }
      if (!outcome.ok) {
        activeExecutions.delete(tab.id);
        failedStep = `Step ${index + 1}: ${outcome.error ?? 'Execution failed'}`;
        break;
      }
      completed += 1;
      if (!outcome.verified) verified = false;
      if (outcome.changed ?? outcome.verified) changed = true;
      if (outcome.detail) details.push(outcome.detail);
      if (openable) {
        // Browsers report the new tab asynchronously; give the action a short,
        // bounded window and never guess about pages opened later.
        const finishedWindow = await waitSlices(tab.id, NEW_PAGE_WINDOW_MS);
        const execution = activeExecutions.get(tab.id);
        activeExecutions.delete(tab.id);
        if (!finishedWindow) {
          failedStep = 'The user left or reset the page; remaining steps were not executed';
          break;
        }
        if (execution && execution.openedTabIds.size) {
          const opened = await describeOpenedTabs(tab, execution);
          record.openedTabs = opened.openedTabs;
          record.openedTabsOverflow = opened.openedTabsOverflow;
          if (opened.openedTabs.length || opened.openedTabsOverflow) {
            failedStep = 'A new page opened; remaining steps need a fresh observation.';
            verified = false;
            changed = true;
            break;
          }
        }
      }
      await sleep(SETTLE_MS);
    }
  } finally {
    activeExecutions.delete(tab.id);
    if (cdp) await setLauncherHidden(cdp, false);
    if (cdp) cdp.close();
    await detach(tab.id);
  }
  if (record.fields.length === 0 && record.clicks.length === 0) record.undoKind = 'unavailable';
  if (record.isUndo && completed === proposal.steps.length) undoRecords.delete(tab.id);
  if (!record.isUndo && record.undoKind !== 'unavailable' && record.undoKind !== 'local' && record.fields.length + record.clicks.length > 0) {
    undoRecords.set(tab.id, record);
    await chrome.storage.session.set({ [`undo:${tab.id}`]: record }).catch(() => {});
  }
  if (!record.isUndo && record.undoKind === 'local' && record.fields.length > 0) {
    undoRecords.set(tab.id, record);
    await chrome.storage.session.set({ [`undo:${tab.id}`]: record }).catch(() => {});
  }
  return { completed, failedStep, verified, changed, record, details };
}

async function executeStep(tab, step, entry, beforeState, cdp, record) {
  const { snapshotId, nodeId } = step;
  const entryFrame = entry.frameId;
  switch (step.type) {
    case 'set_value': {
      const prepared = await agentCall(tab.id, entry, {
        op: 'prepareText', snapshotId, nodeId, expected: beforeState.value,
      });
      if (prepared?.error) {
        return {
          ok: false,
          error: prepared.error === 'text_conflict'
            ? 'The field text changed; observe the page again'
            : prepared.error,
        };
      }
      if (!prepared?.ok) return { ok: false, error: 'Could not prepare the text target; observe again' };
      if (prepared.docToken !== beforeState.docToken) return { ok: false, error: 'The page changed; observe it again' };
      if (typeof prepared.before !== 'string') return { ok: false, error: 'This field cannot be read safely' };
      if (prepared.before.length > MAX_FIELD_VALUE) {
        return { ok: false, error: 'The field is too large to replace safely.' };
      }
      if (executions.stopped(tab.id)) {
        return { ok: false, error: 'The user left or reset the page; remaining steps were not executed' };
      }
      if (prepared.kind === 'segmented') {
        const result = await agentCall(tab.id, entry, {
          op: 'setValue', snapshotId, nodeId, value: step.value,
        });
        if (result?.error) return { ok: false, error: result.error };
      } else if (step.value) {
        await cdp.send('Input.insertText', { text: step.value });
      } else {
        await pressKey(cdp, 'Delete');
      }
      const finished = await agentCall(tab.id, entry, {
        op: 'finishText', snapshotId, nodeId, blur: step.blur !== false,
      });
      if (finished?.error) return { ok: false, error: finished.error };
      if (!finished?.ok) return { ok: false, error: 'Target no longer exists' };
      const after = finished.value;
      record.fields.push({
        kind: 'value', snapshotId, nodeId, frameId: entryFrame, before: prepared.before, after,
      });
      const expected = step.value;
      const matches = prepared.rich
        ? String(after).replace(/\r\n/gu, '\n').replace(/\n$/u, '') === expected
        : after === expected;
      return {
        ok: true,
        verified: matches,
        changed: prepared.before !== after,
        detail: `Filled; current value ${String(after).slice(0, 300)}`,
      };
    }
    case 'set_checked': {
      let result;
      if (beforeState.checkable && beforeState.tag === 'input') {
        result = await agentCall(tab.id, entry, { op: 'setChecked', snapshotId, nodeId, checked: step.checked });
      } else {
        const current = beforeState.ariaChecked ?? beforeState.checked;
        if (current !== null && current !== undefined && String(current) === String(step.checked)) {
          return { ok: true, verified: true, changed: false, detail: 'The control already had the requested state' };
        }
        const point = await targetPoint(tab.id, entry, snapshotId, nodeId, cdp);
        await clickPoint(cdp, point);
        result = await agentCall(tab.id, entry, { op: 'state', snapshotId, nodeId });
      }
      if (result?.error) return { ok: false, error: result.error };
      const after = result.after ?? result;
      record.fields.push({
        kind: after.ariaChecked !== undefined && result.after === undefined ? 'ariaChecked' : 'checked',
        snapshotId, nodeId, frameId: entryFrame,
        before: beforeState.ariaChecked ?? beforeState.checked,
        after: after.ariaChecked ?? after.checked,
      });
      // Target first, then the sibling the browser cleared, so undo unchecks
      // this control and then re-checks the previous one.
      if (result.previousRadio) {
        record.fields.push({
          kind: 'checked', snapshotId, nodeId: result.previousRadio, frameId: entryFrame, before: true, after: false,
        });
      }
      const actual = after.ariaChecked !== undefined && result.after === undefined ? after.ariaChecked : after.checked;
      return { ok: true, verified: String(actual) === String(step.checked), detail: `Checked state updated` };
    }
    case 'select_option': {
      const result = await agentCall(tab.id, entry, { op: 'setSelected', snapshotId, nodeId, values: step.values });
      if (result?.error) return { ok: false, error: result.error };
      record.fields.push({
        kind: 'selected', snapshotId, nodeId, frameId: entryFrame,
        before: beforeState.selected, after: result.after.selected,
      });
      const same = (result.after.selected ?? []).slice().sort().join('\u0000') === step.values.slice().sort().join('\u0000');
      return { ok: true, verified: same, detail: 'Selection updated' };
    }
    case 'set_alt': {
      const result = await agentCall(tab.id, entry, {
        op: 'setAlt', snapshotId, nodeId, alt: step.alt, present: step.present !== false,
      });
      if (result?.error) return { ok: false, error: result.error };
      record.fields.push({
        kind: 'alt', snapshotId, nodeId, frameId: entryFrame,
        before: result.before, after: result.after,
      });
      const wanted = step.present !== false;
      return {
        ok: true,
        verified: result.after.value === step.alt && result.after.present === wanted,
        detail: wanted ? 'Image description written' : 'Image description restored to unset',
      };
    }
    case 'navigate': {
      const previous = entry.documentId ?? observations.get(tab.id)?.documentId ?? null;
      const commit = waitForUrl(tab.id, previous, 8000, { frameId: entry.frameId ?? 0 });
      const result = await agentCall(tab.id, entry, {
        op: 'navigate', snapshotId, nodeId, href: step.href,
      }).catch((error) => ({ error: error?.message ?? 'The link could not be opened' }));
      if (result?.error) {
        commit.cancel();
        return { ok: false, error: result.error };
      }
      const changed = await commit.done;
      return {
        ok: true,
        verified: changed,
        changed,
        detail: changed ? 'Page opened' : 'The page did not finish opening (navigation timeout)',
      };
    }
    case 'click': {
      if (step.point) {
        const target = entry.targets.get(nodeId);
        const visual = entry.visual;
        if (!visual || target?.kind !== 'visual-region') {
          return { ok: false, error: 'Take a fresh screenshot of the page first' };
        }
        if (visual.snapshotId !== step.snapshotId) return { ok: false, error: 'The screenshot expired; observe again' };
        if (beforeState.scrollX !== visual.scroll.x || beforeState.scrollY !== visual.scroll.y) {
          return { ok: false, error: 'The page scrolled; observe again' };
        }
        const fresh = await grabPixels(cdp, visual, beforeState);
        if (fresh.error) return { ok: false, error: fresh.error };
        const hit = await agentCall(tab.id, entry, {
          op: 'hitTest', snapshotId, nodeId, x: step.point.x, y: step.point.y,
        });
        if (hit?.error) return { ok: false, error: hit.error };
        if (!hit.inside || !hit.hit || hit.hit.isFrame) {
          return { ok: false, error: 'That spot is not an available page control; observe again' };
        }
        await withModifiers(cdp, step.modifiers, () => clickPoint(cdp, step.point, {
          button: step.button, clickCount: step.clickCount, holdMs: step.holdMs,
          modifiers: step.modifiers, tabId: tab.id,
        }));
        await sleep(SETTLE_MS);
        const after = await grabPixels(cdp, visual, beforeState, { validate: false });
        const changed = !after.error && fresh.fingerprint !== after.fingerprint;
        return {
          ok: true,
          changed,
          verified: false,
          detail: step.button === 'right'
            ? 'Right-click sent. Observe the page; browser-native menu items cannot be operated.'
            : changed
              ? 'Clicked; the screen changed but the result is not verified'
              : 'Clicked but no visible change was detected',
        };
      }
      const point = await targetPoint(tab.id, entry, snapshotId, nodeId, cdp);
      const before = {
        docToken: beforeState.docToken,
        textHash: beforeState.textHash,
        ariaChecked: beforeState.ariaChecked,
        checked: beforeState.checked,
        ariaExpanded: beforeState.ariaExpanded,
        ariaSelected: beforeState.ariaSelected,
        ariaPressed: beforeState.ariaPressed,
        styleState: beforeState.styleState ?? null,
        appearance: beforeState.appearance ?? null,
      };
      await withModifiers(cdp, step.modifiers, () => clickPoint(cdp, point, {
        button: step.button, clickCount: step.clickCount, holdMs: step.holdMs,
        modifiers: step.modifiers, tabId: tab.id,
      }));
      await sleep(SETTLE_MS);
      let after;
      try {
        after = await agentCall(tab.id, entry, { op: 'state', snapshotId, nodeId, includeHash: true });
      } catch {
        after = { exists: false, docToken: null };
      }
      const navigated = !after || !after.exists || after.docToken !== before.docToken;
      const changed = navigated
        || Boolean(after.textHash && after.textHash !== before.textHash)
        || after.ariaChecked !== before.ariaChecked
        || after.checked !== before.checked
        || after.ariaExpanded !== before.ariaExpanded
        || after.ariaSelected !== before.ariaSelected
        || after.ariaPressed !== before.ariaPressed
        || JSON.stringify(after.styleState ?? null) !== JSON.stringify(before.styleState ?? null)
        || after.appearance !== before.appearance;
      const verified = step.button === 'left' && step.clickCount === 1 && step.holdMs === 0
        && !step.modifiers.length
        && Boolean(navigated || after.ariaChecked !== before.ariaChecked || after.checked !== before.checked);
      record.clicks.push({
        kind: 'click', snapshotId, nodeId, frameId: entryFrame,
        reversible: step.button === 'left' && step.clickCount === 1 && step.holdMs === 0
          && !step.modifiers.length && !navigated,
        before, after: after?.exists ? {
          docToken: after.docToken, textHash: after.textHash, ariaChecked: after.ariaChecked,
          checked: after.checked, ariaExpanded: after.ariaExpanded,
          ariaSelected: after.ariaSelected, ariaPressed: after.ariaPressed,
          styleState: after.styleState ?? null, appearance: after.appearance ?? null,
        } : { docToken: null },
      });
      return {
        ok: true,
        changed,
        verified,
        detail: step.button === 'right'
          ? 'Right-click sent. Observe the page; browser-native menu items cannot be operated.'
          : verified
            ? 'Clicked and checked the page result'
            : changed
              ? 'Clicked; the page changed but the result is not verified'
              : 'Clicked but no confirmable change on the page',
      };
    }
    case 'hover': {
      const target = entry.targets.get(nodeId);
      const visual = entry.visual;
      let point;
      if (step.point) {
        if (!visual || target?.kind !== 'visual-region') {
          return { ok: false, error: 'Take a fresh screenshot of the page first' };
        }
        if (visual.snapshotId !== step.snapshotId) return { ok: false, error: 'The screenshot expired; observe again' };
        if (beforeState.scrollX !== visual.scroll.x || beforeState.scrollY !== visual.scroll.y) {
          return { ok: false, error: 'The page scrolled; observe again' };
        }
        const fresh = await grabPixels(cdp, visual, beforeState);
        if (fresh.error) return { ok: false, error: fresh.error };
        const hit = await agentCall(tab.id, entry, {
          op: 'hitTest', snapshotId, nodeId, x: step.point.x, y: step.point.y,
        });
        if (hit?.error) return { ok: false, error: hit.error };
        if (!hit.inside || !hit.hit || hit.hit.isFrame) {
          return { ok: false, error: 'That spot is not an available page control; observe again' };
        }
        point = step.point;
      } else {
        point = await targetPoint(tab.id, entry, snapshotId, nodeId, cdp);
      }
      await hoverPoint(cdp, point, step.durationMs, tab.id);
      await sleep(SETTLE_MS);
      return {
        ok: true,
        changed: true,
        verified: false,
        detail: `Hovered for ${step.durationMs} ms; observe the page for revealed items.`,
      };
    }
    case 'blur': {
      const result = await agentCall(tab.id, entry, { op: 'blurTarget', snapshotId, nodeId });
      if (result?.error) return { ok: false, error: result.error };
      await sleep(SETTLE_MS);
      const after = await agentCall(tab.id, entry, { op: 'state', snapshotId, nodeId }).catch(() => null);
      const changedNow = result.changed === true;
      return {
        ok: true,
        changed: changedNow,
        verified: true,
        detail: changedNow ? 'Removed focus so the page can update.' : 'The field was not focused; nothing changed.',
      };
    }
    case 'drag': {
      const target = entry.targets.get(nodeId);
      if (!step.points) {
        const end = entry.targets.get(step.toNodeId);
        if (!target || !end) return { ok: false, error: 'A drag endpoint no longer exists; observe again' };
        if (target.kind === 'visual-region' || end.kind === 'visual-region') {
          return { ok: false, error: 'Drag endpoints need page targets, not a screenshot area' };
        }
        const scrolled = await agentCall(tab.id, entry, { op: 'scrollTo', snapshotId, nodeId });
        if (scrolled?.error) return { ok: false, error: scrolled.error };
        const readLocal = (targetId) => agentCall(tab.id, entry, {
          op: 'state', snapshotId, nodeId: targetId,
        });
        const startState = await readLocal(nodeId);
        const endState = await readLocal(step.toNodeId);
        if (!startState?.exists || !endState?.exists) {
          return { ok: false, error: 'A drag endpoint no longer exists; observe again' };
        }
        if (startState.docToken !== entry.docToken || endState.docToken !== entry.docToken) {
          return { ok: false, error: 'The page changed; observe it again' };
        }
        const visibleNow = (state) => state.visible && state.inViewport && !state.disabled;
        if (!visibleNow(startState) || !visibleNow(endState)) {
          return { ok: false, error: 'Both drag endpoints must be visible on screen; observe the page again' };
        }
        const centerOf = (state) => ({
          x: state.rect.x + state.rect.width / 2,
          y: state.rect.y + state.rect.height / 2,
        });
        const startCenter = centerOf(startState);
        const endCenter = centerOf(endState);
        for (const [point, targetId] of [[startCenter, nodeId], [endCenter, step.toNodeId]]) {
          const hit = await agentCall(tab.id, entry, {
            op: 'hitTest', snapshotId, nodeId: targetId, x: point.x, y: point.y,
          });
          if (hit?.error) return { ok: false, error: hit.error };
          if (!hit?.inside || hit.hit?.isFrame || hit.hit?.matchesTarget !== true) {
            return { ok: false, error: 'A drag endpoint is covered or was replaced; observe again' };
          }
        }
        const localPoints = [];
        for (let index = 0; index <= 5; index += 1) {
          localPoints.push({
            x: startCenter.x + ((endCenter.x - startCenter.x) * index) / 5,
            y: startCenter.y + ((endCenter.y - startCenter.y) * index) / 5,
          });
        }
        const masks = await agentCall(tab.id, entry, { op: 'masks' });
        if (masks?.error) return { ok: false, error: masks.error };
        if (localPoints.some((point) => maskHit(point, masks.rects))
          || pointsCrossMask(localPoints, masks.rects)) {
          return { ok: false, error: 'The drag would cross a masked or embedded area' };
        }
        const offset = await framePoint(entry, 0, 0, cdp);
        const startAgain = await readLocal(nodeId);
        const endAgain = await readLocal(step.toNodeId);
        const sameRect = (left, right) => Math.abs(left.x - right.x) <= 1
          && Math.abs(left.y - right.y) <= 1
          && Math.abs(left.width - right.width) <= 1 && Math.abs(left.height - right.height) <= 1;
        if (!startAgain?.exists || !endAgain?.exists
          || startAgain.docToken !== startState.docToken || endAgain.docToken !== endState.docToken
          || !sameRect(startAgain.rect, startState.rect) || !sameRect(endAgain.rect, endState.rect)) {
          return { ok: false, error: 'The page moved while preparing the drag; observe the page again' };
        }
        await dragPoints(cdp, localPoints.map((point) => ({ x: offset.x + point.x, y: offset.y + point.y })), {
          modifiers: step.modifiers, tabId: tab.id,
        });
        await sleep(SETTLE_MS);
        if (executions.stopped(tab.id)) {
          return { ok: true, changed: true, verified: false, detail: 'Cancelled during the drag; the mouse button was released.' };
        }
        return {
          ok: true,
          changed: true,
          verified: false,
          detail: 'Dragged between the two targets; observe the page for the new order or value.',
        };
      }
      const visual = entry.visual;
      if (!visual || target?.kind !== 'visual-region') {
        return { ok: false, error: 'Take a fresh screenshot of the page first' };
      }
      if (visual.snapshotId !== step.snapshotId) return { ok: false, error: 'The screenshot expired; observe again' };
      if (beforeState.scrollX !== visual.scroll.x || beforeState.scrollY !== visual.scroll.y) {
        return { ok: false, error: 'The page scrolled; observe again' };
      }
      const fresh = await grabPixels(cdp, visual, beforeState);
      if (fresh.error) return { ok: false, error: fresh.error };
      const first = await agentCall(tab.id, entry, {
        op: 'hitTest', snapshotId, nodeId, x: step.points[0].x, y: step.points[0].y,
      });
      if (!first?.inside || first.hit?.isFrame) return { ok: false, error: 'The drag start is not available' };
      await dragPoints(cdp, step.points.map(({ x, y }) => ({ x, y })), {
        modifiers: step.modifiers, tabId: tab.id,
      });
      await sleep(SETTLE_MS);
      const after = await grabPixels(cdp, visual, beforeState, { validate: false });
      const changed = !after.error && fresh.fingerprint !== after.fingerprint;
      return {
        ok: true,
        changed,
        verified: false,
        detail: changed
          ? 'Dragged; the screen changed but the result is not verified'
          : 'Dragged but no visible change was detected',
      };
    }
    case 'press_key': {
      const focused = await agentCall(tab.id, entry, { op: 'focus', snapshotId, nodeId });
      if (focused?.error) return { ok: false, error: focused.error };
      const before = await agentCall(tab.id, entry, { op: 'state', snapshotId, nodeId, includeHash: true });
      if (!before?.exists) return { ok: false, error: 'Target no longer exists' };
      if (!before.focused) return { ok: false, error: 'Could not focus the target for the key' };
      await withModifiers(cdp, step.modifiers, () => pressKey(cdp, step.key, step.modifiers));
      await sleep(SETTLE_MS);
      let after;
      try {
        after = await agentCall(tab.id, entry, { op: 'state', snapshotId, nodeId, includeHash: true });
      } catch {
        after = { exists: false };
      }
      const navigated = !after?.exists || after.docToken !== before.docToken;
      const changed = navigated
        || Boolean(after?.textHash && after.textHash !== before.textHash)
        || after?.ariaChecked !== before.ariaChecked
        || after?.checked !== before.checked
        || after?.ariaExpanded !== before.ariaExpanded
        || after?.appearance !== before.appearance;
      return {
        ok: true,
        changed,
        verified: false,
        detail: changed
          ? 'Sent the key and observed a change'
          : 'Sent the key but no change was confirmed',
      };
    }
    default:
      return { ok: false, error: 'Unknown step' };
  }
}

async function requestUndo(tab) {
  return (await executions.run(tab.id, () => undoLastAction(tab))).value;
}

async function undoLastAction(tab) {
  let record = undoRecords.get(tab.id);
  if (!record) {
    const stored = await chrome.storage.session.get(`undo:${tab.id}`).catch(() => ({}));
    record = stored[`undo:${tab.id}`] ?? null;
    if (record) undoRecords.set(tab.id, record);
  }
  if (!record) return { unavailable: true, reason: 'No action to undo' };
  if (record.undoKind === 'unavailable') return { unavailable: true, reason: 'This kind of action cannot be undone automatically' };
  const checked = await detectConflict(record);
  if (checked.conflict) return { conflict: true, reason: checked.conflict };
  const expectedAgainstRecord = checked.expected;
  if (record.undoKind === 'local') {
    const steps = [];
    for (const field of record.fields) steps.push(inverseStep(field));
    const proposal = {
      id: crypto.randomUUID(),
      tabId: tab.id,
      summary: `Undo: ${record.summary}`,
      steps,
      risk: 'local',
      undoKind: 'local',
      isUndo: true,
      documentToken: null,
      expected: expectedAgainstRecord,
    };
    const report = await executeProposal(tab, proposal);
    if (report.completed > 0) {
      undoRecords.delete(tab.id);
      await chrome.storage.session.remove(`undo:${tab.id}`).catch(() => {});
    }
    return { ok: report.completed === steps.length, report };
  }
  const steps = [];
  for (const field of record.fields) steps.push(inverseStep(field));
  for (const click of record.clicks) {
    if (click.reversible !== true) continue;
    if (click.before?.ariaChecked !== click.after?.ariaChecked
      || click.before?.checked !== click.after?.checked) {
      steps.push({ type: 'click', snapshotId: click.snapshotId, nodeId: click.nodeId });
    }
  }
  if (steps.length === 0) return { unavailable: true, reason: 'No step can be safely restored' };
  const proposal = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    documentId: null,
    url: modelUrl(tab.url),
    summary: `Undo: ${record.summary}`,
    steps,
    requirements: [],
    missingFields: [],
    risk: 'compensating',
    undoKind: 'compensating',
    createdAt: Date.now(),
    status: 'proposed',
    isUndo: true,
    expected: expectedAgainstRecord,
  };
  const session = { ...createSession(), phase: PHASE.consent, proposal };
  proposals.set(proposal.id, { session, tabId: tab.id });
  return {
    ok: true,
    requiresConsent: true,
    proposalId: proposal.id,
    summary: proposal.summary,
    risk: 'compensating',
    undoKind: 'compensating',
    stepCount: steps.length,
  };
}

function inverseStep(field) {
  const base = { snapshotId: field.snapshotId, nodeId: field.nodeId };
  if (field.kind === 'value') return { ...base, type: 'set_value', value: field.before ?? '' };
  if (field.kind === 'checked' || field.kind === 'ariaChecked') {
    return { ...base, type: 'set_checked', checked: field.before === true || field.before === 'true' };
  }
  if (field.kind === 'selected') return { ...base, type: 'select_option', values: field.before ?? [] };
  if (field.kind === 'alt') {
    return {
      ...base,
      type: 'set_alt',
      alt: field.before?.value ?? '',
      present: field.before?.present !== false,
    };
  }
  throw new Error('Unknown undo field');
}

async function detectConflict(record) {
  const expected = new Map();
  for (const field of record.fields) {
    const entry = registry.get(field.snapshotId);
    if (!entry || entry.tabId !== record.tabId) return { conflict: 'Page snapshot expired; cannot undo safely' };
    const state = await agentCall(record.tabId, entry, {
      op: 'state', snapshotId: field.snapshotId, nodeId: field.nodeId,
      fullValue: field.kind === 'value',
    }).catch(() => null);
    if (!state?.exists) return { conflict: 'Target was replaced; cannot undo safely' };
    if (field.kind === 'value' && state.value !== field.after) return { conflict: 'Page content changed afterwards; undo would overwrite the new content' };
    if (field.kind === 'checked' && state.checked !== field.after) return { conflict: 'Checked state changed afterwards' };
    if (field.kind === 'ariaChecked' && state.ariaChecked !== field.after) return { conflict: 'Option state changed afterwards' };
    if (field.kind === 'selected' && JSON.stringify(state.selected) !== JSON.stringify(field.after)) return { conflict: 'Selection changed afterwards' };
    if (field.kind === 'alt' && (state.alt?.value !== field.after?.value || state.alt?.present !== field.after?.present)) {
      return { conflict: 'Image description changed afterwards' };
    }
    expected.set(`${field.snapshotId}:${field.nodeId}`, comparable(state));
  }
  for (const click of record.clicks) {
    if (click.reversible !== true) continue;
    const entry = registry.get(click.snapshotId);
    if (!entry) return { conflict: 'Page snapshot expired; cannot undo safely' };
    const state = await agentCall(record.tabId, entry, {
      op: 'state', snapshotId: click.snapshotId, nodeId: click.nodeId,
    }).catch(() => null);
    if (!state?.exists) return { conflict: 'Target was replaced; cannot undo safely' };
    const same = (state.docToken ?? null) === (click.after?.docToken ?? null)
      && (state.ariaChecked ?? null) === (click.after?.ariaChecked ?? null)
      && (state.checked ?? null) === (click.after?.checked ?? null)
      && (state.ariaPressed ?? null) === (click.after?.ariaPressed ?? null)
      && JSON.stringify(state.styleState ?? null) === JSON.stringify(click.after?.styleState ?? null)
      && (state.appearance ?? null) === (click.after?.appearance ?? null);
    if (!same) return { conflict: 'Page state changed afterwards; cannot undo safely' };
    expected.set(`${click.snapshotId}:${click.nodeId}`, comparable(state));
  }
  return { conflict: null, expected };
}

async function resetSession(tabId, { clearSnapshots = false } = {}) {
  if (!Number.isInteger(tabId)) return { ok: true };
  executions.stop(tabId);
  for (const [id, entry] of proposals) if (entry.tabId === tabId) proposals.delete(id);
  if (clearSnapshots) forgetTab(tabId);
  return { ok: true };
}

async function waitForCandidateHttp(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  if (httpUrl(tab.url)) return tab;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      clearTimeout(timer);
      resolve(value);
    };
    const updated = (id, info, changed) => {
      if (id !== tabId) return;
      const candidate = changed ?? info;
      if (candidate && httpUrl(candidate.url)) finish(candidate);
    };
    const removed = (id) => {
      if (id === tabId) finish(null);
    };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function describeOpenedTabs(sourceTab, execution) {
  const ids = [...execution.openedTabIds];
  const openedTabs = [];
  for (const tabId of ids.slice(0, MAX_OPENED_TABS)) {
    const tab = await waitForCandidateHttp(tabId, OPENED_TAB_TIMEOUT_MS);
    if (!tab) continue;
    openedTabs.push({
      tabId: tab.id,
      windowId: tab.windowId,
      sourceTabId: sourceTab.id,
      title: tab.title ?? '',
      url: modelUrl(tab.url),
      origin: originOf(tab.url),
    });
  }
  return { openedTabs, openedTabsOverflow: ids.length > MAX_OPENED_TABS };
}

async function activateTab(message) {
  if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId)) {
    return { error: 'Invalid tab activation' };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(message.tabId);
  } catch {
    return { error: 'The opened page is no longer available' };
  }
  if (tab.windowId !== message.windowId) return { error: 'The opened page moved to another window; choose the page again.' };
  if (!httpUrl(tab.url)) return { error: 'The opened page is not a regular web page' };
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  if (!fresh || !httpUrl(fresh.url)) return { error: 'The opened page is no longer readable' };
  trackTab(fresh);
  return {
    ok: true,
    tabId: fresh.id,
    windowId: fresh.windowId,
    title: fresh.title ?? '',
    url: modelUrl(fresh.url),
    origin: originOf(fresh.url),
  };
}

async function setLauncherPosition(position, sourceTabId) {
  if (!isLauncherPosition(position)) return { error: 'Invalid launcher position' };
  const next = { x: position.x, y: position.y };
  try {
    await chrome.storage.local.set({ launcherPosition: next });
  } catch {
    return { error: 'Could not save the Assistant button position. Try again.' };
  }
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(tabs
    .filter((tab) => tab.id !== sourceTabId && Number.isInteger(tab.id) && httpUrl(tab.url))
    .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'SET_LAUNCHER_POSITION', position: next }).catch(() => {})));
  return { ok: true, position: next };
}

function waitForUrl(tabId, previousDocumentId = null, timeoutMs = 8000, { frameId = 0 } = {}) {
  let settled = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const cleanup = () => {
    chrome.webNavigation.onCommitted.removeListener(listener);
    chrome.tabs.onRemoved.removeListener(removed);
    clearTimeout(timer);
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    settle(value);
  };
  const listener = (details) => {
    if (details.tabId !== tabId || details.frameId !== frameId) return;
    // Same-document history updates and the old document's own commit do not
    // prove this navigation opened anything.
    if (previousDocumentId && details.documentId === previousDocumentId) return;
    finish(true);
  };
  const removed = (id) => {
    if (id === tabId) finish(false);
  };
  chrome.webNavigation.onCommitted.addListener(listener);
  chrome.tabs.onRemoved.addListener(removed);
  const timer = setTimeout(() => finish(false), timeoutMs);
  return { done, cancel: () => finish(false) };
}

const AUTO_ATTACH = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
});

async function detach(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function debuggerSession(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (error) {
    const message = String(error?.message ?? '');
    if (!/already attached/i.test(message)) {
      throw new Error(`Could not connect to the page debugger: ${message || 'close DevTools and try again'}`);
    }
  }
  const cdp = { tabId, sessions: new Set(['']), contexts: [], docFrames: new Map() };
  const onEvent = (source, method, params) => {
    if (source?.tabId !== tabId) return;
    const sessionId = source.sessionId ?? '';
    if (method === 'Target.attachedToTarget') {
      const child = params?.sessionId;
      if (!child) return;
      cdp.sessions.add(child);
      cdp.docFrames.clear();
      // Flat sessions are not recursive: enable the child and let it attach
      // its own embedded descendants.
      cdp.send('Runtime.enable', {}, child).catch(() => {});
      cdp.send('Target.setAutoAttach', AUTO_ATTACH, child).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      cdp.sessions.delete(params?.sessionId ?? '');
      cdp.contexts = cdp.contexts.filter((context) => context.sessionId !== params?.sessionId);
      cdp.docFrames.clear();
    } else if (method === 'Runtime.executionContextCreated') {
      const context = params?.context;
      if (!context || !Number.isInteger(context.id)) return;
      cdp.contexts.push({
        sessionId,
        contextId: context.id,
        frameId: context.auxData?.frameId ?? null,
      });
    } else if (method === 'Runtime.executionContextDestroyed') {
      cdp.contexts = cdp.contexts.filter((context) => !(context.sessionId === sessionId
        && context.contextId === params?.executionContextId));
      cdp.docFrames.clear();
    } else if (method === 'Runtime.executionContextsCleared') {
      cdp.contexts = cdp.contexts.filter((context) => context.sessionId !== sessionId);
      cdp.docFrames.clear();
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  cdp.send = (method, params, sessionId = '') => (sessionId
    ? chrome.debugger.sendCommand({ tabId, sessionId }, method, params)
    : chrome.debugger.sendCommand({ tabId }, method, params));
  cdp.close = () => chrome.debugger.onEvent.removeListener(onEvent);
  try {
    await cdp.send('Target.setAutoAttach', AUTO_ATTACH);
    await cdp.send('Runtime.enable');
  } catch {
    // Geometry needs a proven mapping; absence of contexts fails closed there.
  }
  return cdp;
}

async function documentFrameMap(cdp, tokens) {
  const wanted = new Set(tokens.filter(Boolean));
  const found = new Map();
  if (!wanted.size) return found;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    for (const context of cdp.contexts) {
      if (found.size === wanted.size) break;
      if (!context.frameId) continue;
      const known = [...found.values()].some((entry) => (
        entry.frameId === context.frameId && entry.sessionId === context.sessionId
      ));
      if (known) continue;
      const value = await cdp.send('Runtime.evaluate', {
        expression: 'globalThis.__accessAssistAgent?.docToken ?? null',
        contextId: context.contextId,
        returnByValue: true,
      }, context.sessionId).then((response) => response?.result?.value ?? null).catch(() => null);
      if (wanted.has(value)) {
        found.set(value, { frameId: context.frameId, sessionId: context.sessionId });
      }
    }
    if (found.size === wanted.size) break;
    // Bounded discovery of browser-provided contexts; no page action runs yet.
    await sleep(20);
  }
  for (const [token, info] of found) cdp.docFrames.set(token, info);
  return found;
}

async function frameTreeSessions(cdp) {
  const roots = new Map();
  const parents = new Map();
  const collect = async (sessionId) => {
    const response = await cdp.send('Page.getFrameTree', {}, sessionId).catch(() => null);
    const tree = response?.frameTree;
    if (!tree) return;
    roots.set(tree.frame.id, sessionId);
    const walk = (node, parentId) => {
      if (parentId && !parents.has(node.frame.id)) parents.set(node.frame.id, parentId);
      for (const child of node.childFrames ?? []) walk(child, node.frame.id);
    };
    walk(tree, null);
  };
  await collect('');
  for (const sessionId of [...cdp.sessions]) {
    if (sessionId) await collect(sessionId);
  }
  return { roots, parents };
}

async function frameOffset(cdp, frameId) {
  const { roots, parents } = await frameTreeSessions(cdp);
  let current = frameId;
  let x = 0;
  let y = 0;
  let guard = 0;
  const levels = [];
  while (parents.has(current) && guard < 32) {
    guard += 1;
    const parentId = parents.get(current);
    const sessionId = roots.get(parentId) ?? '';
    await cdp.send('DOM.enable', {}, sessionId).catch(() => {});
    const owner = await cdp.send('DOM.getFrameOwner', { frameId: current }, sessionId);
    if (!owner?.backendNodeId) throw new Error('Could not prove the embedded frame position; observe again');
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: owner.backendNodeId }, sessionId).catch(() => {});
    const model = await cdp.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, sessionId);
    const quad = model?.model?.content;
    if (!quad || quad.length < 8) throw new Error('Could not prove the embedded frame position; observe again');
    x += Math.min(quad[0], quad[2], quad[4], quad[6]);
    y += Math.min(quad[1], quad[3], quad[5], quad[7]);
    levels.push({ sessionId, frameId: parentId, owner: owner.backendNodeId, x, y });
    current = parentId;
  }
  if (guard >= 32) throw new Error('Could not prove the embedded frame position; observe again');
  return { x, y, levels };
}

async function framePoint(entry, x, y, cdp) {
  if (!entry?.docToken) throw new Error('Could not prove the embedded frame position; observe again');
  const mapped = (await documentFrameMap(cdp, [entry.docToken])).get(entry.docToken);
  if (!mapped) throw new Error('Could not prove the embedded frame position; observe again');
  const offset = await frameOffset(cdp, mapped.frameId);
  return {
    x: offset.x + x,
    y: offset.y + y,
    levels: offset.levels.map((level) => ({ ...level, x: level.x + x, y: level.y + y })),
  };
}

// The in-frame hit test cannot see parent-page overlays; prove each frame
// owner is topmost at the point, from an isolated world page scripts cannot patch.
async function assertFramesTopmost(cdp, levels) {
  for (const level of levels) {
    const world = await cdp.send('Page.createIsolatedWorld', {
      frameId: level.frameId, worldName: 'accessassist-hit',
    }, level.sessionId).catch(() => null);
    const resolved = world?.executionContextId
      ? await cdp.send('DOM.resolveNode', {
        backendNodeId: level.owner, executionContextId: world.executionContextId,
      }, level.sessionId).catch(() => null)
      : null;
    if (!resolved?.object?.objectId) throw new Error('Could not prove the embedded frame position; observe again');
    const topmost = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function (x, y) { return this.getRootNode().elementFromPoint(x, y) === this; }',
      arguments: [{ value: level.x }, { value: level.y }],
      returnByValue: true,
    }, level.sessionId).catch(() => null);
    if (topmost?.result?.value !== true) throw new Error('The embedded area is covered; observe the page again');
  }
}

async function targetPoint(tabId, entry, snapshotId, nodeId, cdp) {
  const scrolled = await agentCall(tabId, entry, { op: 'scrollTo', snapshotId, nodeId });
  if (scrolled?.error) throw new Error(scrolled.error);
  const state = scrolled.state ?? await agentCall(tabId, entry, { op: 'state', snapshotId, nodeId });
  if (!state?.exists) throw new Error('Target no longer exists');
  if (!state.visible) throw new Error('Target is not visible');
  const local = { x: state.rect.x + state.rect.width / 2, y: state.rect.y + state.rect.height / 2 };
  const hit = await agentCall(tabId, entry, { op: 'hitTest', snapshotId, nodeId, x: local.x, y: local.y });
  if (hit?.error) throw new Error(hit.error);
  if (!hit?.inside || hit.hit?.isFrame || hit.hit?.matchesTarget !== true) {
    throw new Error('The target is covered or was replaced; observe the page again');
  }
  const point = await framePoint(entry, local.x, local.y, cdp);
  const viewport = await cdp.send('Page.getLayoutMetrics').catch(() => null);
  const size = viewport?.cssLayoutViewport;
  if (size && (point.x < 0 || point.y < 0 || point.x > size.clientWidth || point.y > size.clientHeight)) {
    throw new Error('Target is outside the viewport');
  }
  await assertFramesTopmost(cdp, point.levels);
  return { x: point.x, y: point.y };
}

async function waitSlices(tabId, totalMs) {
  const deadline = Date.now() + totalMs;
  let remaining = totalMs;
  while (remaining > 0) {
    if (executions.stopped(tabId)) return false;
    await sleep(Math.min(50, remaining));
    remaining = deadline - Date.now();
  }
  return !executions.stopped(tabId);
}

const MODIFIER_MASKS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
const MODIFIER_DEFS = Object.freeze({
  Alt: { key: 'Alt', code: 'AltLeft', virtual: 18 },
  Control: { key: 'Control', code: 'ControlLeft', virtual: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', virtual: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', virtual: 16 },
});

function modifiersMask(modifiers = []) {
  return modifiers.reduce((mask, name) => mask | (MODIFIER_MASKS[name] ?? 0), 0);
}

async function withModifiers(cdp, modifiers = [], run) {
  const pressed = [];
  try {
    for (const name of modifiers) {
      const def = MODIFIER_DEFS[name];
      if (!def) throw new Error('Unsupported modifier');
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.virtual,
        nativeVirtualKeyCode: def.virtual,
        modifiers: modifiersMask(pressed) | MODIFIER_MASKS[name],
      });
      pressed.push(name);
    }
    return await run();
  } finally {
    for (const name of [...pressed].reverse()) {
      const def = MODIFIER_DEFS[name];
      const rest = pressed.filter((candidate) => candidate !== name);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.virtual,
        nativeVirtualKeyCode: def.virtual,
        modifiers: modifiersMask(rest),
      }).catch(() => {});
      pressed.splice(pressed.indexOf(name), 1);
    }
  }
}

async function clickPoint(cdp, point, options = {}) {
  const {
    button = 'left', clickCount = 1, holdMs = 0, modifiers = [], tabId = null,
  } = options;
  const buttons = button === 'right' ? 2 : 1;
  const mask = modifiersMask(modifiers);
  const press = (count) => cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: count, modifiers: mask,
  });
  const release = (count) => cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: count, modifiers: mask,
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, modifiers: mask });
  let down = 0;
  try {
    if (clickCount === 2) {
      await press(1);
      await release(1);
      await press(2);
      down = 2;
      await release(2);
      down = 0;
    } else {
      await press(1);
      down = 1;
      if (holdMs > 0) await waitSlices(tabId ?? -1, holdMs);
      await release(1);
      down = 0;
    }
  } finally {
    // Some pages commit on release; never leave the button held after a failure.
    if (down) await release(down).catch(() => {});
  }
}

async function hoverPoint(cdp, point, durationMs, tabId) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
  if (durationMs > 0) await waitSlices(tabId, durationMs);
}

function maskHit(point, masks) {
  return Array.isArray(masks) && masks.some((mask) => (
    point.x >= mask.x && point.x <= mask.x + mask.width
    && point.y >= mask.y && point.y <= mask.y + mask.height
  ));
}

const KEY_DEFS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', virtual: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', virtual: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', virtual: 27 },
  Tab: { key: 'Tab', code: 'Tab', virtual: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', virtual: 8 },
  Delete: { key: 'Delete', code: 'Delete', virtual: 46 },
  F2: { key: 'F2', code: 'F2', virtual: 113 },
  F10: { key: 'F10', code: 'F10', virtual: 112 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', virtual: 93 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', virtual: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', virtual: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', virtual: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', virtual: 39 },
  Home: { key: 'Home', code: 'Home', virtual: 36 },
  End: { key: 'End', code: 'End', virtual: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', virtual: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', virtual: 34 },
});

function keyDef(name) {
  const named = KEY_DEFS[name];
  if (named) return named;
  if (/^[a-z]$/u.test(name)) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, virtual: upper.charCodeAt(0), text: name };
  }
  if (/^[0-9]$/u.test(name)) {
    return { key: name, code: `Digit${name}`, virtual: name.charCodeAt(0), text: name };
  }
  return null;
}

async function pressKey(cdp, name, modifiers = []) {
  const def = keyDef(name);
  if (!def) throw new Error('Unsupported key');
  const shift = modifiers.includes('Shift');
  const command = modifiers.includes('Control') || modifiers.includes('Meta');
  const alt = modifiers.includes('Alt');
  const mask = modifiersMask(modifiers);
  let key = def.key;
  let text = def.text;
  if (shift && /^[a-z]$/u.test(key)) key = key.toUpperCase();
  // Shortcut chords must not also type a character.
  if (command || alt) text = undefined;
  else if (shift && text) text = key;
  const base = {
    key,
    code: def.code,
    windowsVirtualKeyCode: def.virtual,
    nativeVirtualKeyCode: def.virtual,
    modifiers: mask,
    ...(text ? { text, unmodifiedText: def.text ?? text } : {}),
  };
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.virtual,
    nativeVirtualKeyCode: def.virtual,
    modifiers: mask,
  });
}

async function dragPoints(cdp, mapped, { modifiers = [], tabId = null } = {}) {
  if (!mapped.length) return;
  const mask = modifiersMask(modifiers);
  const [start, ...rest] = mapped;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0, modifiers: mask });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers: mask,
  });
  let last = start;
  try {
    for (const point of rest) {
      if (tabId !== null && executions.stopped(tabId)) break;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1, modifiers: mask,
      });
      last = point;
      if (tabId !== null) await waitSlices(tabId, 30);
      else await sleep(30);
    }
  } finally {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, modifiers: mask,
    }).catch(() => {});
  }
}

const PASSWORD_AUTOCOMPLETE = new Set(['current-password', 'new-password']);

function captureError(error) {
  const message = String(error?.message ?? '');
  if (message === REFUSE_CAPTURE || message === STALE_PAGE) return message;
  return `Could not capture the screen: ${message || 'the page did not respond'}`;
}

async function captureCensus(tab, expectedDocumentId) {
  let fresh;
  try {
    fresh = await chrome.tabs.get(tab.id);
  } catch {
    throw new Error(STALE_PAGE);
  }
  if (!fresh || fresh.status !== 'complete') throw new Error(REFUSE_CAPTURE);
  const frames = await framesFor(tab.id);
  const top = pinnedTop(frames, expectedDocumentId);
  if (frames.length !== 1) throw new Error(REFUSE_CAPTURE);
  if (!httpUrl(top.url)) throw new Error(REFUSE_CAPTURE);
  return { top, frames };
}

function attributesOf(node) {
  const map = new Map();
  const flat = node?.attributes ?? [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    map.set(String(flat[index]).toLowerCase(), String(flat[index + 1]));
  }
  return map;
}

// Any embedded document or password field makes the pixels unprovable, even
// when the field is hidden or lives in a shadow root.
function unsafeDomTree(root) {
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    if (visited > 200_000) return true;
    visited += 1;
    const node = stack.pop();
    if (!node) continue;
    const name = String(node.nodeName ?? '').toUpperCase();
    if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(name)) return true;
    if (node.contentDocument) return true;
    if (name === 'INPUT' || name === 'TEXTAREA') {
      const attrs = attributesOf(node);
      if (name === 'INPUT' && (attrs.get('type') ?? '').toLowerCase() === 'password') return true;
      if (PASSWORD_AUTOCOMPLETE.has((attrs.get('autocomplete') ?? '').toLowerCase())) return true;
    }
    for (const child of node.children ?? []) stack.push(child);
    for (const shadow of node.shadowRoots ?? []) stack.push(shadow);
    if (node.templateContent) stack.push(node.templateContent);
  }
  return false;
}

function debuggerEventBarrier(tabId, method, timeoutMs) {
  let settled = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const listener = (source, name) => {
    if (source?.tabId !== tabId || name !== method) return;
    finish(true);
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    chrome.debugger.onEvent.removeListener(listener);
    clearTimeout(timer);
    settle(value);
  };
  chrome.debugger.onEvent.addListener(listener);
  const timer = setTimeout(() => finish(false), timeoutMs);
  return { done, cancel: () => finish(false) };
}

async function withPausedRenderer(tab, expectedDocumentId, { prepare = null, restore = null, run }) {
  try {
    await captureCensus(tab, expectedDocumentId);
  } catch (error) {
    return { error: captureError(error) };
  }
  let cdp;
  try {
    cdp = await debuggerSession(tab.id);
  } catch (error) {
    return { error: captureError(error) };
  }
  let barrier = null;
  let prepared = null;
  let value = null;
  let failure = null;
  try {
    // Attaching shows Chrome's debugging bar, which can shrink the viewport.
    // Measure and re-locate the target only after that resize.
    if (prepare) prepared = await prepare(cdp);
    barrier = debuggerEventBarrier(tab.id, 'Debugger.paused', 3000);
    await cdp.send('Debugger.enable').catch(() => {});
    await cdp.send('Debugger.pause');
    const paused = await barrier.done;
    if (!paused) throw new Error('The page could not be paused; screenshot not taken');
    // Recheck both authorities while script execution is held.
    await captureCensus(tab, expectedDocumentId);
    await cdp.send('DOM.enable').catch(() => {});
    const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    if (!document?.root) throw new Error('Could not inspect the page safely; screenshot not taken');
    if (unsafeDomTree(document.root)) throw new Error(REFUSE_CAPTURE);
    value = await run(cdp, prepared);
  } catch (error) {
    failure = error;
  } finally {
    barrier?.cancel();
    await cdp.send('Debugger.resume').catch(() => {});
    await cdp.send('Debugger.disable').catch(() => {});
    if (restore) await restore(cdp);
    cdp.close();
    await detach(tab.id);
  }
  if (failure) return { error: captureError(failure) };
  try {
    await captureCensus(tab, expectedDocumentId);
  } catch (error) {
    return { error: captureError(error) };
  }
  return value;
}

async function setLauncherHidden(cdp, hidden) {
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const host = document.getElementById(${JSON.stringify(LAUNCHER_ID)}); if (host) host.style.visibility = ${hidden ? "'hidden'" : "''"}; })()`,
  }).catch(() => {});
}

async function measureViewport(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: '({ width: innerWidth, height: innerHeight, scrollX, scrollY })',
    returnByValue: true,
  }).catch(() => null);
  const value = result?.result?.value;
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
    throw new Error('Could not measure the page');
  }
  return value;
}

async function pixelDigest(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const digest = await crypto.subtle.digest('SHA-256', pixels);
  return {
    fingerprint: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
    pixels,
  };
}

function samePixelRegion(fresh, freshWidth, stored, storedWidth, width, height) {
  if (!fresh || !stored || width < 1 || height < 1) return false;
  if (fresh.length < freshWidth * height * 4 || stored.length < storedWidth * height * 4) return false;
  for (let row = 0; row < height; row += 1) {
    const freshStart = row * freshWidth * 4;
    const storedStart = row * storedWidth * 4;
    for (let index = 0; index < width * 4; index += 1) {
      if (fresh[freshStart + index] !== stored[storedStart + index]) return false;
    }
  }
  return true;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function viewportShot(cdp, viewport, scroll) {
  const captured = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: scroll.x, y: scroll.y, width: viewport.width, height: viewport.height, scale: 1 },
  });
  if (!captured?.data) throw new Error('Could not capture the screen');
  const raw = await (await fetch(`data:image/png;base64,${captured.data}`)).blob();
  const bitmap = await createImageBitmap(raw);
  const scale = bitmap.width / viewport.width;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Could not determine the screenshot scale');
  if (bitmap.width !== Math.round(viewport.width * scale) || bitmap.height !== Math.round(viewport.height * scale)) {
    throw new Error('The browser cropped the screenshot; screenshot not taken');
  }
  return { dataUrl: `data:image/png;base64,${captured.data}`, bitmap, scale };
}

async function captureViewport(tab, visual, { expectedDocumentId }) {
  try {
    await captureCensus(tab, expectedDocumentId);
  } catch (error) {
    return { error: captureError(error) };
  }
  return withPausedRenderer(tab, expectedDocumentId, {
    prepare: async (cdp) => {
      await setLauncherHidden(cdp, true);
      return measureViewport(cdp);
    },
    restore: (cdp) => setLauncherHidden(cdp, false),
    run: async (cdp, viewport) => {
      const captured = await viewportShot(cdp, viewport, { x: viewport.scrollX, y: viewport.scrollY });
      const digest = await pixelDigest(captured.bitmap);
      const width = captured.bitmap.width;
      const height = captured.bitmap.height;
      captured.bitmap.close();
      return {
        dataUrl: captured.dataUrl,
        width,
        height,
        scale: captured.scale,
        viewport: { width: viewport.width, height: viewport.height },
        scroll: { x: viewport.scrollX, y: viewport.scrollY },
        pixels: digest.pixels,
        fingerprint: digest.fingerprint,
      };
    },
  });
}

async function grabPixels(cdp, visual, beforeState, { validate = true } = {}) {
  const current = beforeState?.viewport;
  // Chrome's debugging bar can shrink the viewport after the screenshot. The
  // pixels still visible at action time must match the screenshot exactly.
  if (!current || current.scrollX !== visual.scroll.x || current.scrollY !== visual.scroll.y) {
    return { error: 'The page scrolled; observe it again' };
  }
  const width = Math.min(current.width, visual.viewport.width);
  const height = Math.min(current.height, visual.viewport.height);
  if (width < 1 || height < 1) return { error: 'The page shrank; observe it again' };
  const captured = await viewportShot(cdp, { width, height }, visual.scroll)
    .catch((error) => ({ error: error?.message ?? 'Could not capture the screen' }));
  if (captured.error) return { error: captured.error };
  const digest = await pixelDigest(captured.bitmap);
  const freshWidth = captured.bitmap.width;
  const freshHeight = captured.bitmap.height;
  captured.bitmap.close();
  if (validate) {
    const storedWidth = Math.round(visual.viewport.width * visual.scale);
    if (!visual.pixels || captured.scale !== visual.scale
      || !samePixelRegion(digest.pixels, freshWidth, visual.pixels, storedWidth, freshWidth, freshHeight)) {
      return { error: 'The page changed since the screenshot; observe again' };
    }
    visual.pixels = null;
  }
  return { fingerprint: digest.fingerprint };
}

async function cropPng(dataUrl, source, scale) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const x = Math.max(0, Math.floor(source.x * scale));
  const y = Math.max(0, Math.floor(source.y * scale));
  const width = Math.max(1, Math.min(bitmap.width - x, Math.ceil(source.width * scale)));
  const height = Math.max(1, Math.min(bitmap.height - y, Math.ceil(source.height * scale)));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  const cropped = await canvas.convertToBlob({ type: 'image/png' });
  return { dataUrl: await blobToDataUrl(cropped), width, height };
}

async function captureTarget(tab, message) {
  const found = registryTarget(message.snapshotId, message.nodeId);
  if (!found || found.entry.tabId !== tab.id) return { error: 'Observe the image again first' };
  if (!['img', 'canvas', 'svg'].includes(found.target.tag)) return { error: 'Target is not an image' };
  if (found.entry.frameId !== 0) return { error: REFUSE_CAPTURE };
  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  if (!fresh?.active) return { error: 'Switch back to the page to capture first' };
  const capture = await withPausedRenderer(tab, message.expectedDocumentId, {
    prepare: async (cdp) => {
      await setLauncherHidden(cdp, true);
      const scrolled = await agentCall(tab.id, found.entry, {
        op: 'scrollTo', snapshotId: message.snapshotId, nodeId: message.nodeId,
      }).catch((error) => ({ error: error?.message ?? STALE_PAGE }));
      if (scrolled?.error) throw new Error(scrolled.error);
      const state = scrolled.state;
      if (!state?.exists || !state.visible || !state.inViewport) throw new Error('Image is outside the viewport; cannot capture');
      if (state.docToken !== found.entry.docToken) throw new Error(STALE_PAGE);
      return state;
    },
    restore: (cdp) => setLauncherHidden(cdp, false),
    run: async (cdp, state) => {
      const viewport = state.viewport;
      if (!viewport) throw new Error('Could not measure the page');
      const captured = await viewportShot(cdp, viewport, { x: viewport.scrollX, y: viewport.scrollY });
      const x = Math.max(0, state.rect.x);
      const y = Math.max(0, state.rect.y);
      const right = Math.min(state.rect.x + state.rect.width, viewport.width);
      const bottom = Math.min(state.rect.y + state.rect.height, viewport.height);
      const rect = { x, y, width: right - x, height: bottom - y };
      if (rect.width < 2 || rect.height < 2) throw new Error('Image area is too small to read');
      captured.bitmap.close();
      return { dataUrl: captured.dataUrl, rect, scale: captured.scale };
    },
  });
  if (capture.error) return capture;
  try {
    const cropped = await cropPng(capture.dataUrl, capture.rect, capture.scale);
    return { ok: true, dataUrl: cropped.dataUrl, width: cropped.width, height: cropped.height };
  } catch {
    return { error: 'Could not crop the image' };
  }
}

initialize();
