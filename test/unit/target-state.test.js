import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_FIELDS,
  CONFLICT_CLICK_FIELDS,
  KEY_FIELDS,
  changedSince,
  conflictFor,
  differsFromApproved,
  driftFromObserved,
  pickState,
  projectTargetState,
} from '../../extension/target-state.js';

const live = {
  docToken: 'doc-1',
  disabled: false,
  visible: true,
  name: 'Save',
  role: 'button',
  tag: 'button',
  link: null,
  value: null,
  checked: null,
  ariaChecked: null,
  ariaSelected: null,
  styleState: { className: '', backgroundColor: 'rgb(1, 2, 3)', color: 'rgb(4, 5, 6)' },
  selected: null,
  alt: null,
  rect: { x: 10, y: 20, width: 100, height: 30 },
};

test('an approved proposal is checked against the observed target', () => {
  const observed = {
    visible: true, disabled: false, name: 'Save', role: 'button', tag: 'button',
    value: null, checked: null, ariaChecked: null,
  };
  const step = { type: 'click', snapshotId: 's1', nodeId: 3 };
  assert.equal(driftFromObserved(step, { ...observed }, observed), null);
  assert.equal(driftFromObserved(step, { ...observed, name: 'Delete' }, observed), 'name');
  assert.equal(driftFromObserved(step, { ...observed, disabled: true }, observed), 'disabled');
  // collectTargets overrides the role of extra targets, so role is not compared.
  assert.equal(driftFromObserved(step, { ...observed, role: 'region' }, observed), null);
  // A screenshot point is anchored to frozen pixels, not to the control's own text.
  assert.equal(driftFromObserved({ ...step, point: { x: 1, y: 1 } }, { ...observed, name: 'Delete' }, observed), null);
  assert.equal(driftFromObserved(step, null, observed), 'target');
  const text = { ...observed, tag: 'div', value: 'a b' };
  assert.equal(driftFromObserved(step, { ...text, contentEditable: true, value: 'a\n  b' }, text), null);
  assert.equal(driftFromObserved(step, { ...text, value: 'x'.repeat(400) }, { ...text, value: 'x'.repeat(300) }), null);
  assert.equal(driftFromObserved(step, { ...text, value: 'typed' }, { ...text, value: '' }), 'value');
});

test('a target is compared with the approved state field by field', () => {
  const approved = projectTargetState(live);
  const step = { type: 'click', snapshotId: 's1', nodeId: 3 };
  assert.equal(differsFromApproved(step, live, approved), null);
  assert.equal(
    differsFromApproved(step, { ...live, name: 'Delete' }, approved),
    'Page state changed (name); observe the page again',
  );
  assert.equal(
    differsFromApproved(step, { ...live, rect: { ...live.rect, x: 60 } }, approved),
    'Page state changed (rect); observe the page again',
  );
  // A screenshot point only trusts frozen pixels, so a renamed target there still matches.
  assert.equal(differsFromApproved({ ...step, point: { x: 1, y: 1 } }, { ...live, name: 'Delete', rect: { ...live.rect, x: 60 } }, approved), null);
  assert.equal(
    differsFromApproved(step, { ...live, selected: ['b'] }, { ...approved, selected: ['a'] }),
    'Page state changed; observe the page again',
  );
  assert.equal(differsFromApproved(step, live, undefined), null);
});

test('a projected target normalizes rect and style state', () => {
  const projected = projectTargetState({
    ...live,
    rect: { x: 1.4, y: 1.6, width: 2.4, height: 2.6 },
    styleState: undefined,
  });
  assert.deepEqual(projected.rect, { x: 1, y: 2, width: 2, height: 3 });
  assert.equal(projected.styleState, null);
  assert.equal(projectTargetState({ ...live, rect: null }).rect, null);
});

test('a click change check compares only its own fields', () => {
  const before = pickState(live, CLICK_FIELDS);
  assert.deepEqual(changedSince(before, { ...live, exists: true }, CLICK_FIELDS), {
    navigated: false,
    changed: false,
  });
  assert.deepEqual(changedSince(before, { ...live, checked: true }, CLICK_FIELDS), {
    navigated: false,
    changed: true,
  });
  assert.deepEqual(changedSince(before, { ...live, docToken: 'doc-2' }, CLICK_FIELDS), {
    navigated: true,
    changed: true,
  });
  assert.deepEqual(changedSince(before, { exists: false, docToken: null }, CLICK_FIELDS), {
    navigated: true,
    changed: true,
  });
  // The key effect and the undo conflict check use narrower field sets than a click.
  const keyBefore = pickState(live, KEY_FIELDS);
  assert.deepEqual(
    changedSince(keyBefore, {
      ...live,
      ariaSelected: 'true',
      ariaPressed: 'true',
      styleState: { className: 'moved' },
    }, KEY_FIELDS),
    { navigated: false, changed: false },
  );
  const conflictBefore = pickState(live, CONFLICT_CLICK_FIELDS);
  assert.equal(changedSince(conflictBefore, { ...live, textHash: 'other' }, CONFLICT_CLICK_FIELDS).changed, false);
});

test('a recorded field reports the conflict that would block undo', () => {
  assert.equal(conflictFor({ kind: 'value', after: 'a' }, { value: 'b' }), 'Page content changed afterwards; undo would overwrite the new content');
  assert.equal(conflictFor({ kind: 'checked', after: true }, { checked: false }), 'Checked state changed afterwards');
  assert.equal(conflictFor({ kind: 'ariaChecked', after: 'true' }, { ariaChecked: null }), 'Option state changed afterwards');
  assert.equal(conflictFor({ kind: 'selected', after: ['a'] }, { selected: ['b'] }), 'Selection changed afterwards');
  assert.equal(
    conflictFor({ kind: 'alt', after: { present: true, value: 'a' } }, { alt: { present: true, value: 'b' } }),
    'Image description changed afterwards',
  );
  assert.equal(conflictFor({ kind: 'value', after: 'a' }, { value: 'a' }), null);
});

test('a picked state keeps the field order and nulls missing values', () => {
  const picked = pickState({}, CLICK_FIELDS);
  assert.deepEqual(Object.keys(picked), [...CLICK_FIELDS]);
  assert.equal(Object.values(picked).every((value) => value === null), true);
});
