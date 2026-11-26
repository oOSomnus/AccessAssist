// Pure projections and comparisons of one target's state, shared by the worker
// and unit tests. page-agent.js is injected as a classic script and cannot
// import, so it repeats VALUE_CHAR_LIMIT at its two value truncations.
export const VALUE_CHAR_LIMIT = 300;

// Screenshot points are anchored to frozen pixels and re-hit-tested, so only visibility matters.
export const OBSERVED_POINT_FIELDS = Object.freeze(['visible']);
// Rect is excluded (scrolling moves it); role is excluded because extra targets override it.
export const OBSERVED_CONTROL_FIELDS = Object.freeze(['visible', 'disabled', 'name', 'tag', 'checked', 'ariaChecked', 'value']);
export const APPROVED_POINT_FIELDS = Object.freeze(['docToken', 'visible']);
// Computed styleState, not raw class/style text: CSSOM serialization can change while rendering stays identical.
export const APPROVED_CONTROL_FIELDS = Object.freeze(['docToken', 'visible', 'disabled', 'name', 'role', 'tag', 'link', 'value', 'checked', 'ariaChecked', 'ariaSelected', 'styleState', 'alt', 'rect']);
// Click feedback and the stored click record.
export const CLICK_FIELDS = Object.freeze(['docToken', 'textHash', 'ariaChecked', 'checked', 'ariaExpanded', 'ariaSelected', 'ariaPressed', 'styleState', 'appearance']);
// Narrower than CLICK_FIELDS; reason not recorded in code, preserved as is.
export const KEY_FIELDS = Object.freeze(['docToken', 'textHash', 'ariaChecked', 'checked', 'ariaExpanded', 'appearance']);
// Undo conflict check on a recorded click; reason for the narrower set not recorded in code, preserved as is.
export const CONFLICT_CLICK_FIELDS = Object.freeze(['docToken', 'ariaChecked', 'checked', 'ariaPressed', 'styleState', 'appearance']);

export function roundedRect(rect) {
  return rect
    ? {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
    : null;
}

export function projectTargetState(state) {
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
    rect: roundedRect(state.rect),
  };
}

export function pickState(state, fields) {
  return Object.fromEntries(fields.map((field) => [field, state[field] ?? null]));
}

export function changedSince(before, after, fields) {
  if (!after || after.exists === false) return { navigated: true, changed: true };
  const navigated = (after.docToken ?? null) !== (before?.docToken ?? null);
  const changed = navigated || fields.some((field) => (
    JSON.stringify(after[field] ?? null) !== JSON.stringify(before?.[field] ?? null)
  ));
  return { navigated, changed };
}

export function driftFromObserved(step, live, observed) {
  if (!live || !observed) return 'target';
  const keys = step.point || step.points ? OBSERVED_POINT_FIELDS : OBSERVED_CONTROL_FIELDS;
  for (const key of keys) {
    let current = live[key];
    // Observations hold the first 300 characters (whitespace-cleaned for contenteditable).
    if (key === 'value' && typeof current === 'string') {
      current = (live.contentEditable
        ? current.replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()
        : current).slice(0, VALUE_CHAR_LIMIT);
    }
    if (JSON.stringify(current) !== JSON.stringify(observed[key])) return key;
  }
  return null;
}

export function differsFromApproved(step, state, expected) {
  if (!expected) return null;
  const current = projectTargetState(state);
  // Raw class/style text is excluded: CSSOM serialization can change while the
  // rendered target stays identical. Computed styleState, geometry, semantic
  // state, and the hit test still catch real moves, recolors, and overlays.
  // A screenshot point is anchored to frozen pixels and re-hit-tested, not to
  // the synthetic visual region's own geometry.
  const keys = step.point || step.points ? APPROVED_POINT_FIELDS : APPROVED_CONTROL_FIELDS;
  for (const key of keys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(expected[key])) return `Page state changed (${key}); observe the page again`;
  }
  if (!step.point && !step.points && JSON.stringify(current.selected) !== JSON.stringify(expected.selected)) {
    return 'Page state changed; observe the page again';
  }
  return null;
}

// One approved batch: the targets of later steps, read once just before the
// first step runs. A target that still matched what the user approved may
// take whatever state the batch's own steps give it; one that had already
// drifted keeps being checked against the approved state, so outside drift
// still fails. Unreadable targets are never trusted.
export function trustedAtStart(expected, states) {
  const trusted = new Set();
  for (const [key, state] of states) {
    const approved = expected.get(key);
    if (!approved || !state?.exists) continue;
    if (differsFromApproved({}, state, approved)) continue;
    trusted.add(key);
  }
  return trusted;
}

export function conflictFor(field, state) {
  if (field.kind === 'value' && state.value !== field.after) return 'Page content changed afterwards; undo would overwrite the new content';
  if (field.kind === 'checked' && state.checked !== field.after) return 'Checked state changed afterwards';
  if (field.kind === 'ariaChecked' && state.ariaChecked !== field.after) return 'Option state changed afterwards';
  if (field.kind === 'selected' && JSON.stringify(state.selected) !== JSON.stringify(field.after)) return 'Selection changed afterwards';
  if (field.kind === 'alt' && (state.alt?.value !== field.after?.value || state.alt?.present !== field.after?.present)) {
    return 'Image description changed afterwards';
  }
  return null;
}
