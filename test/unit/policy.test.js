import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE,
  pointMasked,
  pointsCrossMask,
  acceptConsent,
  armConsent,
  createSession,
  finishExecution,
  timeNeedsClarification,
  validateProposal,
} from '../../extension/policy.js';

const target = (overrides = {}) => ({
  disabled: false, visible: true, editable: false, checkable: false, selectable: false,
  submits: false, link: null, alt: null, kind: 'native-control', focusable: false,
  docToken: 'doc', ...overrides,
});

function context(overrides = {}) {
  const targets = new Map([
    ['s1:1', target({ editable: true })],
    ['s1:2', target({ checkable: true })],
    ['s1:3', target({ visible: true, submits: true, link: 'https://example.test/next' })],
    ['s1:4', target({ alt: { present: false, value: '' } })],
    ['s1:5', target({ disabled: true, editable: true })],
    ['s1:6', target({ selectable: true })],
  ]);
  return {
    tabId: 7, windowId: 3, documentId: 'doc', url: 'https://example.test/',
    userText: 'Change the name to Alex Morgan at 2 PM',
    pageText: 'Name Choice A Monday',
    confirmedChoices: new Set(['pm', 'PM']),
    targets,
    now: 1000,
    ...overrides,
  };
}

const proposal = (overrides = {}) => ({
  summary: 'Change the name',
  steps: [{ type: 'set_value', snapshotId: 's1', nodeId: 1, value: 'Alex Morgan' }],
  ...overrides,
});

test('short clock values need a meridiem but 24-hour values do not', () => {
  assert.equal(timeNeedsClarification('2:00 to 3:00'), true);
  assert.equal(timeNeedsClarification('2:00'), true);
  assert.equal(timeNeedsClarification('2 PM'), false);
  assert.equal(timeNeedsClarification('2 p.m.'), false);
  assert.equal(timeNeedsClarification('14:00 to 15:00'), false);
  assert.equal(timeNeedsClarification('15 minutes'), false);
  assert.equal(timeNeedsClarification('Monday 2:00; Tuesday 3:00 PM'), true);
  assert.equal(timeNeedsClarification('2:00 to 3:00 PM'), false);
  assert.equal(timeNeedsClarification('Monday 2:00 PM, Tuesday 3:00 PM'), false);
});

test('missing fields keep the session in clarification', () => {
  const outcome = validateProposal(proposal({ missingFields: ['AM or PM'] }), context());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.phase, PHASE.clarification);
});

test('requirements must quote real inputs or confirmed choices', () => {
  const ok = validateProposal(proposal({
    requirements: [
      { name: 'name', value: 'Alex Morgan', source: 'user', quote: 'Alex Morgan' },
      { name: 'time', value: '2 PM', source: 'user', quote: '2 PM' },
      { name: 'day', value: 'pm', source: 'choice', quote: 'pm' },
    ],
  }), context());
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const badUser = validateProposal(proposal({
    requirements: [{ name: 'name', value: 'Jordan Lee', source: 'user', quote: 'Jordan Lee' }],
  }), context());
  assert.equal(badUser.ok, false);
  assert.match(badUser.errors.join(), /quotes the user/u);
  const badPage = validateProposal(proposal({
    requirements: [{ name: 'choice', value: 'B', source: 'page', quote: 'Choice B' }],
  }), context());
  assert.equal(badPage.ok, false);
  const badChoice = validateProposal(proposal({
    requirements: [{ name: 'time', value: '2 AM', source: 'choice', quote: 'AM' }],
  }), context());
  assert.equal(badChoice.ok, false);
});

test('ambiguous times are rejected before consent', () => {
  const outcome = validateProposal(proposal({
    requirements: [{ name: 'time', value: '2:00 to 3:00', source: 'user', quote: '2:00 to 3:00' }],
  }), context({ userText: 'Select at 2:00 to 3:00' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsClarification, true);
});

test('steps validate against observed targets and risk', () => {
  const local = validateProposal(proposal({
    steps: [{ type: 'set_alt', snapshotId: 's1', nodeId: 4, alt: 'A red circle' }],
  }), context());
  assert.equal(local.proposal.risk, 'local');
  assert.equal(local.proposal.undoKind, 'local');

  const edits = validateProposal(proposal({
    steps: [{ type: 'set_value', snapshotId: 's1', nodeId: 1, value: 'Alex Morgan' }],
  }), context());
  assert.equal(edits.proposal.risk, 'compensating');

  const submit = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 3 }],
  }), context());
  assert.equal(submit.proposal.risk, 'irreversible');
  assert.equal(submit.proposal.undoKind, 'unavailable');

  const grid = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 7 }],
  }), context({ targets: new Map([['s1:7', target({ role: 'gridcell' })]]) }));
  assert.equal(grid.proposal.risk, 'compensating');
  assert.equal(grid.proposal.undoKind, 'compensating');

  const disabled = validateProposal(proposal({
    steps: [{ type: 'set_value', snapshotId: 's1', nodeId: 5, value: 'x' }],
  }), context());
  assert.equal(disabled.ok, false);
  assert.match(disabled.errors.join(), /disabled/u);

  const unknownTarget = validateProposal(proposal({
    steps: [{ type: 'set_value', snapshotId: 's1', nodeId: 99, value: 'x' }],
  }), context());
  assert.equal(unknownTarget.ok, false);
});

test('custom, visual, and key actions are irreversible and constrained', () => {
  const base = context();
  const visual = target({
    kind: 'visual-region',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    masks: [{ x: 10, y: 10, width: 20, height: 20 }],
  });
  const ctx = context({
    targets: new Map([
      ...base.targets,
      ['s1:8', visual],
      ['s1:9', target({ kind: 'custom-control', role: 'button' })],
      ['s1:10', target({ focusable: true, role: 'tab' })],
    ]),
  });

  const custom = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 9 }],
  }), ctx);
  assert.equal(custom.proposal.risk, 'irreversible');
  assert.equal(custom.proposal.undoKind, 'unavailable');

  const point = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 8, point: { x: 100, y: 100 } }],
  }), ctx);
  assert.equal(point.ok, true, JSON.stringify(point.errors));
  assert.equal(point.proposal.risk, 'irreversible');

  const outside = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 8, point: { x: 900, y: 20 } }],
  }), ctx);
  assert.equal(outside.ok, false);

  const masked = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 8, point: { x: 15, y: 15 } }],
  }), ctx);
  assert.equal(masked.ok, false);

  const invalidPoint = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 8, point: { x: Number.NaN, y: 10 } }],
  }), ctx);
  assert.equal(invalidPoint.ok, false);

  const withoutScreenshot = validateProposal(proposal({
    steps: [{ type: 'click', snapshotId: 's1', nodeId: 1, point: { x: 5, y: 5 } }],
  }), ctx);
  assert.equal(withoutScreenshot.ok, false);

  const drag = validateProposal(proposal({
    steps: [{ type: 'drag', snapshotId: 's1', nodeId: 8, points: [{ x: 50, y: 50 }, { x: 200, y: 50 }] }],
  }), ctx);
  assert.equal(drag.ok, true, JSON.stringify(drag.errors));

  const crossing = validateProposal(proposal({
    steps: [{ type: 'drag', snapshotId: 's1', nodeId: 8, points: [{ x: 0, y: 20 }, { x: 100, y: 20 }] }],
  }), ctx);
  assert.equal(crossing.ok, false);
  assert.match(crossing.errors.join(), /masked area/u);
  assert.equal(pointsCrossMask([{ x: 0, y: 20 }, { x: 100, y: 20 }], [{ x: 10, y: 10, width: 20, height: 20 }]), true);
  assert.equal(pointsCrossMask([{ x: 0, y: 20 }, { x: 5, y: 20 }], [{ x: 10, y: 10, width: 20, height: 20 }]), false);
  const mask = [{ x: 10, y: 10, width: 20, height: 20 }];
  assert.equal(pointMasked({ x: 10, y: 10 }, mask), true);
  assert.equal(pointMasked({ x: 31, y: 10 }, mask), false);

  const mixed = validateProposal(proposal({
    steps: [
      { type: 'click', snapshotId: 's1', nodeId: 8, point: { x: 100, y: 100 } },
      { type: 'click', snapshotId: 's1', nodeId: 9 },
    ],
  }), ctx);
  assert.equal(mixed.ok, false);
  assert.match(mixed.errors.join(), /fresh observation/u);

  const key = validateProposal(proposal({
    steps: [{ type: 'press_key', snapshotId: 's1', nodeId: 10, key: 'Enter' }],
  }), ctx);
  assert.equal(key.ok, true, JSON.stringify(key.errors));
  assert.equal(key.proposal.risk, 'irreversible');

  const badKey = validateProposal(proposal({
    steps: [{ type: 'press_key', snapshotId: 's1', nodeId: 10, key: 'F5' }],
  }), ctx);
  assert.equal(badKey.ok, false);

  const unfocusable = validateProposal(proposal({
    steps: [{ type: 'press_key', snapshotId: 's1', nodeId: 1, key: 'Enter' }],
  }), ctx);
  assert.equal(unfocusable.ok, false);
});

test('embedded frame targets use their own document token', () => {
  const frameTarget = target({ editable: true, frameId: 3, docToken: 'frame-token' });
  const ctx = context({
    documentId: 'top-token',
    documentIds: new Map([[0, 'top-token'], [3, 'frame-token']]),
    targets: new Map([['s1:1', frameTarget]]),
  });
  const outcome = validateProposal(proposal(), ctx);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));

  const stale = context({
    documentId: 'top-token',
    documentIds: new Map([[0, 'top-token'], [3, 'new-frame-token']]),
    targets: new Map([['s1:1', frameTarget]]),
  });
  assert.equal(validateProposal(proposal(), stale).ok, false);
});

test('stale document targets are rejected', () => {
  const ctx = context({
    documentId: 'other',
    targets: new Map([['s1:1', target({ editable: true, docToken: 'doc' })]]),
  });
  const outcome = validateProposal(proposal(), ctx);
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors.join(), /page changed/u);
});

test('irreversible actions need two separate confirmations', () => {
  let session = createSession();
  const outcome = validateProposal(proposal({ steps: [{ type: 'click', snapshotId: 's1', nodeId: 3 }] }), context());
  session = { ...session, phase: PHASE.consent, proposal: outcome.proposal };
  session = armConsent(session, { choiceSetId: 'a', now: 1000 }).session;
  const first = acceptConsent(session, { choiceSetId: 'a', optionValue: 'execute', now: 1001 });
  assert.equal(first.action, 'risk');
  assert.equal(first.session.phase, PHASE.risk);
  const reused = acceptConsent(first.session, { choiceSetId: 'a', optionValue: 'execute', now: 1002 });
  assert.match(reused.error, /expired/u);
  const second = armConsent(first.session, { choiceSetId: 'b', now: 1003 }).session;
  const execute = acceptConsent(second, { choiceSetId: 'b', optionValue: 'execute', now: 1004 });
  assert.equal(execute.action, 'execute');
  assert.equal(execute.session.phase, PHASE.executing);
});

test('consent expires, cancels and cannot be consumed twice', () => {
  let session = { ...createSession(), phase: PHASE.consent, proposal: proposal() };
  session = armConsent(session, { choiceSetId: 'a', now: 1000 }).session;
  assert.match(acceptConsent(session, { choiceSetId: 'a', optionValue: 'execute', now: 200000 }).error, /timed out/u);
  const cancelled = acceptConsent(session, { choiceSetId: 'a', optionValue: 'cancel', now: 1001 });
  assert.equal(cancelled.action, 'cancel');
  assert.equal(cancelled.session.phase, PHASE.guide);
  const wrong = acceptConsent(session, { choiceSetId: 'other', optionValue: 'execute', now: 1001 });
  assert.match(wrong.error, /expired/u);
});

test('execution requires at least one completed step for result confirmation', () => {
  let session = { ...createSession(), phase: PHASE.executing, proposal: proposal() };
  const failed = finishExecution(session, { completedSteps: 0, failedStep: 'Target moved' });
  assert.equal(failed.phase, PHASE.guide);
  assert.match(failed.error, /incomplete/u);
  session = { ...createSession(), phase: PHASE.executing, proposal: proposal() };
  const partial = finishExecution(session, {
    completedSteps: 2, failedStep: 'The second step was stale', verified: false, changed: true, undoKind: 'compensating',
  });
  assert.equal(partial.phase, PHASE.result);
  assert.equal(partial.session.result.undoKind, 'compensating');
  assert.equal(partial.session.result.changed, true);
  assert.equal(partial.session.proposal.status, 'unverified');
});

test('new pointer and key fields are normalized with strict bounds', () => {
  const base = context();
  const ctx = context({
    targets: new Map([
      ...base.targets,
      ['s1:11', target({ editable: true, contentEditable: true })],
      ['s1:12', target({ role: 'button', inViewport: true })],
      ['s1:13', target({ role: 'button', inViewport: true, frameId: 2, docToken: 'doc' })],
      ['s1:14', target({ kind: 'visual-region', rect: { x: 0, y: 0, width: 800, height: 600 }, masks: [] })],
      ['s1:15', target({ focusable: true, role: 'tab' })],
    ]),
  });
  const check = (steps) => validateProposal(proposal({ steps }), ctx);
  const clickStep = (extra) => ({ type: 'click', snapshotId: 's1', nodeId: 12, ...extra });

  const plain = check([clickStep({})]);
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
  assert.equal(plain.proposal.steps[0].button, 'left');
  assert.equal(plain.proposal.steps[0].clickCount, 1);
  assert.equal(plain.proposal.steps[0].holdMs, 0);
  assert.deepEqual(plain.proposal.steps[0].modifiers, []);

  assert.equal(check([clickStep({ button: 'middle' })]).ok, false);
  assert.equal(check([clickStep({ clickCount: 3 })]).ok, false);
  assert.equal(check([clickStep({ clickCount: 2, holdMs: 10 })]).ok, false);
  assert.equal(check([clickStep({ holdMs: 1600 })]).ok, false);
  assert.equal(check([clickStep({ modifiers: ['Shift', 'Shift'] })]).ok, false);
  assert.equal(check([clickStep({ modifiers: ['Control', 'Meta'] })]).ok, false);
  assert.equal(check([clickStep({ modifiers: ['Hyper'] })]).ok, false);
  assert.equal(check([clickStep({ value: 'x' })]).ok, false);

  const double = check([clickStep({ clickCount: 2 })]);
  assert.equal(double.ok, true, JSON.stringify(double.errors));
  assert.equal(double.proposal.risk, 'irreversible');
  const held = check([clickStep({ holdMs: 700 })]);
  assert.equal(held.proposal.risk, 'irreversible');
  const shifted = check([clickStep({ modifiers: ['Shift'] })]);
  assert.equal(shifted.proposal.risk, 'irreversible');
  const right = check([clickStep({ button: 'right' })]);
  assert.equal(right.proposal.risk, 'irreversible');

  const press = (key, modifiers) => check([{ type: 'press_key', snapshotId: 's1', nodeId: 15, key, modifiers }]);
  assert.equal(press('a', []).ok, true);
  assert.equal(press('a', ['Shift']).ok, true);
  assert.equal(press('a', ['Control']).ok, true);
  assert.equal(press('c', ['Control']).ok, false);
  assert.equal(press('v', ['Meta']).ok, false);
  assert.equal(press('x', ['Control']).ok, false);
  assert.equal(press('ArrowDown', ['Alt']).ok, true);
  assert.equal(press('b', ['Alt']).ok, false);
  assert.equal(press('ArrowDown', ['Alt', 'Control']).ok, false);
  assert.equal(press('F10', []).ok, false);
  assert.equal(press('F10', ['Shift']).ok, true);
  assert.equal(press('ContextMenu', ['Control']).ok, false);
  assert.equal(press('F2', []).ok, true);
  assert.equal(press('Tab', []).ok, true);

  const hover = check([{ type: 'hover', snapshotId: 's1', nodeId: 12 }]);
  assert.equal(hover.ok, true, JSON.stringify(hover.errors));
  assert.equal(hover.proposal.steps[0].durationMs, 500);
  assert.equal(hover.proposal.risk, 'irreversible');
  assert.equal(check([{ type: 'hover', snapshotId: 's1', nodeId: 12, durationMs: 1501 }]).ok, false);

  const blur = check([{ type: 'blur', snapshotId: 's1', nodeId: 15 }]);
  assert.equal(blur.ok, true, JSON.stringify(blur.errors));
  assert.equal(blur.proposal.risk, 'irreversible');
  assert.equal(check([{ type: 'blur', snapshotId: 's1', nodeId: 14 }]).ok, false);

  const value = check([{ type: 'set_value', snapshotId: 's1', nodeId: 1, value: 'Alex' }]);
  assert.equal(value.proposal.steps[0].blur, true);
  assert.equal(value.proposal.risk, 'compensating');
  assert.equal(check([{ type: 'set_value', snapshotId: 's1', nodeId: 1, value: 'Alex', blur: false }]).proposal.steps[0].blur, false);
  assert.equal(check([{ type: 'set_value', snapshotId: 's1', nodeId: 11, value: 'Rich' }]).proposal.risk, 'irreversible');
});

test('DOM drag endpoints are validated as one same-frame pair', () => {
  const base = context();
  const ctx = context({
    targets: new Map([
      ...base.targets,
      ['s1:20', target({ role: 'button', inViewport: true })],
      ['s1:21', target({ role: 'button', inViewport: true })],
      ['s1:22', target({ role: 'button', inViewport: true, frameId: 2, docToken: 'doc' })],
      ['s1:23', target({ role: 'button', inViewport: false })],
      ['s1:24', target({ kind: 'visual-region', rect: { x: 0, y: 0, width: 800, height: 600 } })],
    ]),
  });
  const drag = (extra) => validateProposal(proposal({
    steps: [{ type: 'drag', snapshotId: 's1', nodeId: 20, ...extra }],
  }), ctx);

  const ok = drag({ toNodeId: 21 });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.proposal.steps[0].toNodeId, 21);
  assert.equal(ok.proposal.risk, 'irreversible');

  assert.equal(drag({ toNodeId: 21, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }).ok, false);
  assert.equal(drag({}).ok, false);
  assert.equal(drag({ toNodeId: 20 }).ok, false);
  assert.equal(drag({ toNodeId: 99 }).ok, false);
  assert.equal(drag({ toNodeId: 22 }).ok, false);
  assert.match(drag({ toNodeId: 22 }).errors.join(), /same frame/u);
  assert.equal(drag({ toNodeId: 23 }).ok, false);
  assert.equal(drag({ toNodeId: 21, modifiers: ['Control', 'Meta'] }).ok, false);

  const fromVisual = validateProposal(proposal({
    steps: [{ type: 'drag', snapshotId: 's1', nodeId: 24, toNodeId: 21 }],
  }), ctx);
  assert.equal(fromVisual.ok, false);

  const mixed = validateProposal(proposal({
    steps: [
      { type: 'drag', snapshotId: 's1', nodeId: 20, toNodeId: 21 },
      { type: 'click', snapshotId: 's1', nodeId: 21 },
    ],
  }), ctx);
  assert.equal(mixed.ok, false);
  assert.match(mixed.errors.join(), /fresh observation/u);
});
