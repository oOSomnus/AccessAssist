import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESS_KEYS,
  STEP_TYPES,
  TOOLS,
  closeChoiceSet,
  createChoiceSet,
  labelViolation,
  parseChoiceNumber,
  resolveChoice,
} from '../../extension/protocol.js';

test('point, key, and visual observation schemas stay constrained', () => {
  assert.ok(STEP_TYPES.includes('press_key'));
  const propose = TOOLS.find((tool) => tool.name === 'propose_action');
  const step = propose.parameters.properties.steps.items;
  assert.deepEqual(step.properties.key.enum, [...PRESS_KEYS]);
  assert.deepEqual(step.properties.point.required, ['x', 'y']);
  assert.equal(step.properties.point.additionalProperties, false);
  const observe = TOOLS.find((tool) => tool.name === 'observe_page');
  assert.equal(observe.parameters.properties.visual.type, 'boolean');
});

test('labels stay short and reject empty labels', () => {
  assert.equal(labelViolation('Screen reader'), null);
  assert.equal(labelViolation('Run anyway'), null);
  assert.equal(labelViolation('This option'), null);
  assert.match(labelViolation('openai compatible protocol choice'), /at most 4 words and 24 characters/u);
  assert.match(labelViolation('   '), /empty/u);
});

test('choice sets number options in order', () => {
  const set = createChoiceSet({
    id: 'c1',
    question: 'How should I describe this image?',
    options: [
      { label: 'Read it', value: 'ai' },
      { label: 'Screen reader', value: 'guide' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  assert.deepEqual(set.options.map((option) => option.number), [1, 2, 3]);
  assert.deepEqual(set.options.map((option) => option.label), ['Read it', 'Screen reader', 'Cancel']);
  assert.equal(set.status, 'open');
});

test('choice sets reject duplicate or numeric labels', () => {
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: 'Yes', value: 'a' }, { label: 'Yes', value: 'b' }],
  }), /Duplicate option label/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: '1', value: 'a' }, { label: 'No', value: 'b' }],
  }), /only a number/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: 'Yes' }, { label: 'No', value: 'b' }],
  }), /must have text/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: 'Yes', value: 'a' }, { label: 'Yes.', value: 'b' }],
  }), /Duplicate option label/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: 'Yes', value: 'go' }, { label: 'No', value: 'Go.' }],
  }), /Duplicate option value/u);
});

test('choice sets reject non-string content instead of coercing it', () => {
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 7,
    options: [{ label: 'Yes', value: 'a' }],
  }), /Question must be text/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: { text: 'Yes' }, value: 'a' }, { label: 'No', value: 'b' }],
  }), /must have text/u);
  assert.throws(() => createChoiceSet({
    id: 'x',
    question: 'q',
    options: [{ label: 'Yes', value: null }, { label: 'No', value: 'b' }],
  }), /must have text/u);
});

test('answers accept numbers, number words, labels and values', () => {
  const set = createChoiceSet({
    id: 'c2',
    question: 'AM or PM?',
    options: [{ label: 'AM', value: 'am' }, { label: 'PM', value: 'pm' }],
  });
  for (const input of ['1', 'one', 'option one', 'AM', 'am', ' 1. ']) {
    const result = resolveChoice(set, input);
    assert.equal(result.ok, true, input);
    assert.equal(result.option.value, 'am', input);
  }
  assert.equal(resolveChoice(set, 'two').option.value, 'pm');
  assert.equal(resolveChoice(set, '3').ok, false);
  assert.equal(resolveChoice(set, 'maybe').reason, 'invalid');
  assert.equal(resolveChoice({ ...set, status: 'closed' }, '1').reason, 'closed');
  assert.equal(resolveChoice({ ...set, used: true }, '1').reason, 'closed');
  assert.equal(parseChoiceNumber('option 2'), 2);
  assert.equal(parseChoiceNumber('second'), null);
  const continueSet = createChoiceSet({
    id: 'c4',
    question: 'Continue?',
    options: [{ label: 'Continue?', value: 'next' }, { label: 'Stop', value: 'stop' }],
  });
  const continued = resolveChoice(continueSet, 'Continue?');
  assert.equal(continued.ok, true);
  assert.equal(continued.option.value, 'next');
});

test('expired and consumed choice sets reject answers even before a timer fires', () => {
  const set = createChoiceSet({
    id: 'c3',
    question: 'Run this?',
    options: [{ label: 'Run', value: 'execute' }, { label: 'Cancel', value: 'cancel' }],
    expiresAt: Date.now() - 1,
  });
  assert.deepEqual(resolveChoice(set, '1'), { ok: false, reason: 'expired' });
  const closed = closeChoiceSet(set, 'answered');
  assert.equal(closed.status, 'answered');
  assert.equal(closed.used, true);
  assert.equal(set.status, 'open');
  assert.equal(resolveChoice(closed, '1').reason, 'closed');
  const fresh = createChoiceSet({
    id: 'c4',
    question: 'Run this?',
    options: [{ label: 'Run', value: 'execute' }],
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(resolveChoice(fresh, 'one').ok, true);
});
