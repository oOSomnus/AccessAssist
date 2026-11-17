// Consent, proposal validation and one-time choice rules. Pure state so the
// worker and unit tests exercise the same code without Chrome APIs.
import { PRESS_KEYS, PRESS_MODIFIERS, STEP_TYPES } from './protocol.js';

export const PHASE = Object.freeze({
  guide: 'guide',
  consent: 'awaiting_consent',
  risk: 'awaiting_risk_consent',
  executing: 'executing',
  result: 'awaiting_result_confirmation',
});

export const CONSENT_TIMEOUT_MS = 120_000;
const RISK_ORDER = ['local', 'compensating', 'irreversible'];
const SAFE_CLICK_ROLES = new Set(['checkbox', 'radio', 'switch', 'tab', 'option', 'gridcell', 'cell', 'row', 'treeitem']);
const MAX_SUMMARY = 400;
const MAX_VALUE = 2000;
const MAX_ALT = 1000;

export function createSession() {
  return {
    phase: PHASE.guide,
    proposal: null,
    consent: null,
    usedConsentIds: [],
    result: null,
  };
}

export function riskFor(steps) {
  let risk = 'local';
  for (const step of steps) {
    let current = 'local';
    if (step.type === 'navigate') current = 'irreversible';
    else if (step.type === 'click') {
      const unusual = step.button === 'right' || step.clickCount === 2
        || step.holdMs > 0 || (step.modifiers?.length ?? 0) > 0;
      if (step.point || step.kind === 'visual-region' || step.submits || unusual) current = 'irreversible';
      else if (SAFE_CLICK_ROLES.has(step.role) && step.togglesChecked) current = 'compensating';
      else current = 'irreversible';
    } else if (step.type === 'hover' || step.type === 'blur') current = 'irreversible';
    else if (step.type === 'drag' || step.type === 'press_key') current = 'irreversible';
    else if (step.type === 'set_value') current = step.contentEditable ? 'irreversible' : 'compensating';
    else if (step.type === 'set_checked' || step.type === 'select_option') current = 'compensating';
    else if (step.type === 'set_alt') current = 'local';
    else current = 'irreversible';
    if (RISK_ORDER.indexOf(current) > RISK_ORDER.indexOf(risk)) risk = current;
  }
  return risk;
}

export function undoKindFor(risk) {
  if (risk === 'local') return 'local';
  if (risk === 'compensating') return 'compensating';
  return 'unavailable';
}

// Undoable work needs no question: the user can undo it. Hover is irreversible
// only because its result cannot be restored, and it changes nothing by itself.
export function autoRuns(proposal) {
  return proposal.risk !== 'irreversible' || proposal.steps.every((step) => step.type === 'hover');
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validNodeId(value) {
  return Number.isInteger(value) && value >= 1;
}

function finitePoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 50) return false;
  return points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function pointInRect(point, rect) {
  return Boolean(rect)
    && point.x >= rect.x - 1 && point.x <= rect.x + rect.width + 1
    && point.y >= rect.y - 1 && point.y <= rect.y + rect.height + 1;
}

export function pointMasked(point, masks) {
  return Array.isArray(masks) && masks.some((mask) => rectContains(mask, point));
}

function rectContains(rect, point) {
  return Boolean(rect)
    && point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function segmentCrossesRect(start, end, rect) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let enter = 0;
  let exit = 1;
  const edges = [
    [-dx, start.x - rect.x],
    [dx, rect.x + rect.width - start.x],
    [-dy, start.y - rect.y],
    [dy, rect.y + rect.height - start.y],
  ];
  for (const [direction, offset] of edges) {
    if (direction === 0) {
      if (offset < 0) return false;
      continue;
    }
    const ratio = offset / direction;
    if (direction < 0) {
      if (ratio > exit) return false;
      if (ratio > enter) enter = ratio;
    } else {
      if (ratio < enter) return false;
      if (ratio < exit) exit = ratio;
    }
  }
  return true;
}

export function pointsCrossMask(points, masks) {
  if (!Array.isArray(points) || !Array.isArray(masks) || points.length < 2) return false;
  for (let index = 1; index < points.length; index += 1) {
    for (const mask of masks) {
      if (segmentCrossesRect(points[index - 1], points[index], mask)) return true;
    }
  }
  return false;
}

export const STEP_FIELDS = Object.freeze({
  set_value: new Set(['value', 'blur']),
  set_checked: new Set(['checked']),
  select_option: new Set(['values']),
  click: new Set(['point', 'button', 'clickCount', 'holdMs', 'modifiers']),
  hover: new Set(['point', 'durationMs']),
  drag: new Set(['points', 'toNodeId', 'modifiers']),
  press_key: new Set(['key', 'modifiers']),
  navigate: new Set(['href']),
  set_alt: new Set(['alt']),
  blur: new Set(),
});

const CONTROLLED_KEYS = new Set([
  'a', 'z', 'y', 'Enter', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
]);

function readModifiers(raw) {
  if (raw === undefined) return { modifiers: [] };
  if (!Array.isArray(raw)) return { error: 'Invalid modifiers' };
  const seen = new Set();
  for (const name of raw) {
    if (!PRESS_MODIFIERS.includes(name)) return { error: 'Unsupported modifier' };
    if (seen.has(name)) return { error: 'Duplicate modifier' };
    seen.add(name);
  }
  if (seen.has('Control') && seen.has('Meta')) return { error: 'Control and Meta cannot be combined' };
  return { modifiers: [...raw] };
}

// Keys that also drive the browser chrome stay reachable only through narrow,
// page-editing combinations; clipboard and tab-management shortcuts stay out.
function modifierError(key, modifiers) {
  const has = new Set(modifiers);
  const command = has.has('Control') || has.has('Meta');
  const alt = has.has('Alt');
  const shift = has.has('Shift');
  if (command && !CONTROLLED_KEYS.has(key)) return `Control or Meta cannot be combined with ${key}`;
  if (alt && command) return 'Alt cannot be combined with Control or Meta';
  if (alt && key !== 'ArrowUp' && key !== 'ArrowDown') return `Alt cannot be combined with ${key}`;
  if (key === 'F10' && !(shift && !command && !alt)) return 'F10 needs Shift and no other modifier';
  if ((key === 'F2' || key === 'ContextMenu') && (command || alt)) {
    return `${key} cannot use Control, Meta or Alt`;
  }
  return null;
}

function readInteger(raw, fallback, min, max) {
  if (raw === undefined) return { value: fallback };
  if (!Number.isInteger(raw) || raw < min || raw > max) return { error: 'Invalid number range' };
  return { value: raw };
}

function readPoint(rawPoint, target) {
  if (target.kind !== 'visual-region') return { error: 'Point actions need a fresh screenshot of the viewport' };
  if (!rawPoint || !Number.isFinite(rawPoint.x) || !Number.isFinite(rawPoint.y)) {
    return { error: 'Invalid point' };
  }
  if (!pointInRect(rawPoint, target.rect)) return { error: 'Point is outside the screenshot area' };
  if (pointMasked(rawPoint, target.masks)) return { error: 'That area is masked and cannot be clicked' };
  return { point: { x: rawPoint.x, y: rawPoint.y } };
}

export function validateStep(raw, ctx) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid step format' };
  if (!STEP_TYPES.includes(raw.type)) return { ok: false, error: 'Unknown step type' };
  const allowed = STEP_FIELDS[raw.type];
  for (const key of Object.keys(raw)) {
    if (key === 'type' || key === 'snapshotId' || key === 'nodeId') continue;
    if (!allowed?.has(key)) return { ok: false, error: `Field ${key} is not valid for ${raw.type}` };
  }
  if (typeof raw.snapshotId !== 'string' || !raw.snapshotId) return { ok: false, error: 'Missing snapshot id' };
  if (!validNodeId(raw.nodeId)) return { ok: false, error: 'Missing target node id' };
  const target = ctx.targets?.get(`${raw.snapshotId}:${raw.nodeId}`);
  if (!target) return { ok: false, error: 'Target is not in the observed page snapshot' };
  const documentToken = ctx.documentIds?.get?.(target.frameId)
    ?? (target.frameId === undefined || target.frameId === 0 ? ctx.documentId : null);
  if (target.docToken && documentToken && target.docToken !== documentToken) {
    return { ok: false, error: 'The page changed; observe it again' };
  }
  if (target.disabled) return { ok: false, error: 'Target is disabled' };
  const step = {
    type: raw.type,
    snapshotId: raw.snapshotId,
    nodeId: raw.nodeId,
    submits: target.submits === true,
    role: target.role ?? '',
    kind: target.kind ?? 'native-control',
    focusable: target.focusable === true,
    contentEditable: target.contentEditable === true,
    masks: Array.isArray(target.masks) ? target.masks : [],
  };
  switch (raw.type) {
    case 'set_value': {
      if (!target.editable) return { ok: false, error: 'Target does not accept text input' };
      if (target.readOnly) return { ok: false, error: 'The field is read-only' };
      if (typeof raw.value !== 'string') return { ok: false, error: 'Missing text to fill in' };
      if (raw.value.length > MAX_VALUE) return { ok: false, error: 'Text is too long' };
      if (raw.blur !== undefined && typeof raw.blur !== 'boolean') return { ok: false, error: 'Invalid blur setting' };
      step.value = raw.value;
      step.blur = raw.blur ?? true;
      break;
    }
    case 'set_checked':
      if (!target.checkable) return { ok: false, error: 'Target is not a checkable control' };
      if (typeof raw.checked !== 'boolean') return { ok: false, error: 'Missing checked state' };
      step.checked = raw.checked;
      break;
    case 'select_option':
      if (!target.selectable) return { ok: false, error: 'Target is not a select control' };
      if (!Array.isArray(raw.values) || raw.values.length === 0) return { ok: false, error: 'Missing option values' };
      if (!raw.values.every((value) => typeof value === 'string' && value.length <= MAX_VALUE)) {
        return { ok: false, error: 'Invalid option value' };
      }
      step.values = [...raw.values];
      break;
    case 'click': {
      if (raw.point !== undefined) {
        const read = readPoint(raw.point, target);
        if (read.error) return { ok: false, error: read.error };
        step.point = read.point;
      } else if (target.kind === 'visual-region') {
        return { ok: false, error: 'A screenshot target needs an explicit point' };
      }
      if (!target.visible) return { ok: false, error: 'Target is not visible' };
      const button = raw.button ?? 'left';
      if (button !== 'left' && button !== 'right') return { ok: false, error: 'Unsupported mouse button' };
      const clickCount = raw.clickCount ?? 1;
      if (clickCount !== 1 && clickCount !== 2) return { ok: false, error: 'Unsupported click count' };
      const hold = readInteger(raw.holdMs, 0, 0, 1500);
      if (hold.error) return { ok: false, error: 'Invalid hold duration' };
      if (clickCount === 2 && (button !== 'left' || hold.value !== 0)) {
        return { ok: false, error: 'A double click must be a quick left click' };
      }
      const mods = readModifiers(raw.modifiers);
      if (mods.error) return { ok: false, error: mods.error };
      step.button = button;
      step.clickCount = clickCount;
      step.holdMs = hold.value;
      step.modifiers = mods.modifiers;
      // Undo reverses a click only by clicking again, which restores checked state alone.
      step.togglesChecked = (target.ariaChecked ?? null) !== null || typeof target.checked === 'boolean';
      break;
    }
    case 'hover': {
      if (raw.point !== undefined) {
        const read = readPoint(raw.point, target);
        if (read.error) return { ok: false, error: read.error };
        step.point = read.point;
      } else if (target.kind === 'visual-region') {
        return { ok: false, error: 'A screenshot target needs an explicit point' };
      }
      if (!target.visible) return { ok: false, error: 'Target is not visible' };
      const duration = readInteger(raw.durationMs, 500, 0, 1500);
      if (duration.error) return { ok: false, error: 'Invalid hover duration' };
      step.durationMs = duration.value;
      break;
    }
    case 'drag': {
      const hasPoints = raw.points !== undefined;
      const hasTarget = raw.toNodeId !== undefined;
      if (hasPoints === hasTarget) {
        return { ok: false, error: 'A drag needs either screenshot points or one endpoint target' };
      }
      const mods = readModifiers(raw.modifiers);
      if (mods.error) return { ok: false, error: mods.error };
      step.modifiers = mods.modifiers;
      if (hasPoints) {
        if (target.kind !== 'visual-region') return { ok: false, error: 'Drag coordinates need a fresh screenshot of the viewport' };
        if (!finitePoints(raw.points)) return { ok: false, error: 'Invalid drag coordinates' };
        const first = raw.points[0];
        const last = raw.points.at(-1);
        if (Math.abs(first.x - last.x) <= 1 && Math.abs(first.y - last.y) <= 1) {
          return { ok: false, error: 'Drag endpoints must be different points' };
        }
        if (!raw.points.every((point) => pointInRect(point, target.rect))) {
          return { ok: false, error: 'Drag coordinates are outside the screenshot area' };
        }
        if (raw.points.some((point) => pointMasked(point, target.masks))
          || pointsCrossMask(raw.points, target.masks)) {
          return { ok: false, error: 'Drag crosses a masked area' };
        }
        step.points = raw.points.map(({ x, y }) => ({ x, y }));
        break;
      }
      if (target.kind === 'visual-region') return { ok: false, error: 'Drag endpoints need page targets, not a screenshot area' };
      if (!validNodeId(raw.toNodeId) || raw.toNodeId === raw.nodeId) {
        return { ok: false, error: 'Invalid drag endpoint' };
      }
      const end = ctx.targets?.get(`${raw.snapshotId}:${raw.toNodeId}`);
      if (!end) return { ok: false, error: 'Drag endpoint is not in the observed page snapshot' };
      if (end.frameId !== target.frameId) return { ok: false, error: 'Drag endpoints must be in the same frame' };
      if (end.disabled) return { ok: false, error: 'Drag endpoint is disabled' };
      if (!target.visible || !target.inViewport || !end.visible || !end.inViewport) {
        return { ok: false, error: 'Both drag endpoints must be visible on screen' };
      }
      step.toNodeId = raw.toNodeId;
      break;
    }
    case 'press_key': {
      if (!PRESS_KEYS.includes(raw.key)) return { ok: false, error: 'Unsupported key' };
      if (target.kind === 'visual-region') return { ok: false, error: 'Choose a focusable page target for the key' };
      if (!target.focusable) return { ok: false, error: 'Target cannot receive keyboard focus' };
      if (!target.visible) return { ok: false, error: 'Target is not visible' };
      const mods = readModifiers(raw.modifiers);
      if (mods.error) return { ok: false, error: mods.error };
      const comboError = modifierError(raw.key, mods.modifiers);
      if (comboError) return { ok: false, error: comboError };
      step.key = raw.key;
      step.modifiers = mods.modifiers;
      break;
    }
    case 'navigate': {
      const href = str(raw.href);
      if (!/^https?:\/\//iu.test(href)) return { ok: false, error: 'Only HTTP or HTTPS links can be opened' };
      if (!target.link || !target.modelLink || target.modelLink !== href) {
        return { ok: false, error: 'Link does not match the observed target' };
      }
      // The model decides from the sanitized URL; execution uses the exact URL
      // the page showed when the user approved it.
      step.href = target.link;
      break;
    }
    case 'set_alt':
      if (!target.alt) return { ok: false, error: 'Target is not an image' };
      if (target.alt.present) return { ok: false, error: 'Image already has alt text; not overwriting' };
      if (typeof raw.alt !== 'string' || !raw.alt.trim() || raw.alt.length > MAX_ALT) {
        return { ok: false, error: 'Description is empty or too long' };
      }
      step.alt = raw.alt.trim();
      break;
    case 'blur':
      if (target.kind === 'visual-region') return { ok: false, error: 'Choose a page target to blur' };
      if (!target.visible) return { ok: false, error: 'Target is not visible' };
      break;
    default:
      return { ok: false, error: 'Unknown step type' };
  }
  return { ok: true, step };
}

export function isIsolatedStep(step) {
  if (step.type === 'hover' || step.type === 'blur' || step.type === 'drag') return true;
  if (step.point) return true;
  return step.type === 'click' && (step.button === 'right' || step.clickCount === 2
    || step.holdMs > 0 || (step.modifiers?.length ?? 0) > 0);
}

export function validateProposal(raw, ctx) {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Invalid proposal format'] };
  const summary = str(raw.summary);
  const errors = [];
  if (!summary) errors.push('Missing summary');
  else if (summary.length > MAX_SUMMARY) errors.push('Summary is too long');
  const steps = [];
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) errors.push('No executable steps');
  else if (raw.steps.length > 20) errors.push('Too many steps');
  else {
    const acted = new Set();
    raw.steps.forEach((candidate, index) => {
      const outcome = validateStep(candidate, ctx);
      if (outcome.ok) {
        // A second click or navigation on the same document node is either a
        // duplicate of the first or a page script replay, not a new decision.
        if (outcome.step.type === 'click' || outcome.step.type === 'navigate') {
          const target = ctx.targets?.get(`${candidate.snapshotId}:${candidate.nodeId}`);
          const identity = target?.docToken ?? target?.documentId ?? target?.frameId ?? 'top';
          const key = `${identity}:${candidate.nodeId}`;
          if (acted.has(key)) {
            errors.push(`Step ${index + 1}: That control is already acted on in this proposal`);
          } else {
            acted.add(key);
          }
        }
        steps.push(outcome.step);
      } else errors.push(`Step ${index + 1}: ${outcome.error}`);
    });
  }
  // Actions whose trust comes from a fresh observation cannot share a proposal
  // with anything else: the second step would plan from stale page state.
  const isolated = steps.filter((step) => isIsolatedStep(step));
  if (isolated.length > 1) errors.push('Only one action that needs a fresh observation can be proposed at a time');
  else if (isolated.length === 1 && steps.length > 1) {
    errors.push('An action that needs a fresh observation must be proposed alone; observe again after it');
  }
  if (errors.length) return { ok: false, errors };
  const proposal = {
    id: globalThis.crypto.randomUUID(),
    tabId: ctx.tabId,
    windowId: ctx.windowId,
    documentId: ctx.documentId ?? null,
    url: ctx.url ?? '',
    snapshotId: ctx.snapshotId ?? null,
    summary,
    steps,
    risk: riskFor(steps),
    undoKind: undoKindFor(riskFor(steps)),
    createdAt: ctx.now ?? Date.now(),
    status: 'proposed',
  };
  return { ok: true, proposal };
}

export function cancelToGuide(session) {
  return { ...session, phase: PHASE.guide, proposal: null, consent: null, result: null };
}

export function armConsent(session, { choiceSetId, now = Date.now() }) {
  if (session.phase !== PHASE.consent && session.phase !== PHASE.risk) {
    return { error: 'There is no pending confirmation' };
  }
  return {
    session: {
      ...session,
      consent: { choiceSetId, expiresAt: now + CONSENT_TIMEOUT_MS, used: false },
    },
  };
}

export function autoConsent(session) {
  if (session.phase !== PHASE.consent) return { error: 'There is no pending confirmation' };
  if (!autoRuns(session.proposal)) return { error: 'This action needs the user to confirm it' };
  return { session: { ...session, phase: PHASE.executing, consent: null } };
}

export function acceptConsent(session, { choiceSetId, optionValue, now = Date.now() }) {
  if (session.phase !== PHASE.consent && session.phase !== PHASE.risk) {
    return { error: 'There is no pending confirmation' };
  }
  const consent = session.consent;
  if (!consent || consent.choiceSetId !== choiceSetId) return { error: 'This confirmation expired; choose again' };
  if (consent.used || session.usedConsentIds.includes(choiceSetId)) return { error: 'This confirmation was already used' };
  if (optionValue === 'cancel') return { session: cancelToGuide(session), action: 'cancel' };
  if (now > consent.expiresAt) return { error: 'Confirmation timed out; propose the action again' };
  if (optionValue !== 'execute') return { error: 'Invalid confirmation option' };
  const used = {
    ...session,
    usedConsentIds: [...session.usedConsentIds, choiceSetId],
    consent: { ...consent, used: true },
  };
  if (session.phase === PHASE.consent && session.proposal?.risk === 'irreversible') {
    return { session: { ...used, phase: PHASE.risk, consent: null }, action: 'risk' };
  }
  return { session: { ...used, phase: PHASE.executing, consent: null }, action: 'execute' };
}

export function finishExecution(session, { completedSteps, failedStep = null, verified = true, changed = verified, undoKind }) {
  if (session.phase !== PHASE.executing) return { error: 'No action is executing' };
  if (completedSteps <= 0) {
    return {
      session: cancelToGuide(session),
      phase: PHASE.guide,
      error: failedStep ? `Action incomplete: ${failedStep}` : 'Action produced no confirmable result',
    };
  }
  return {
    session: {
      ...session,
      phase: PHASE.result,
      consent: null,
      result: { completedSteps, failedStep, verified, changed, undoKind },
      proposal: session.proposal ? { ...session.proposal, status: verified ? 'executed' : 'unverified' } : null,
    },
    phase: PHASE.result,
  };
}
