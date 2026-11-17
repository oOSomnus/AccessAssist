import test from 'node:test';
import assert from 'node:assert/strict';
import { consentRound } from '../../extension/consent-round.js';

const question = { tabId: 7, proposalId: 'p', question: 'Run this?', runLabel: 'Run', keepLabel: 'Cancel' };

function fakeSend(handler) {
  const calls = [];
  const send = async (type, payload) => {
    calls.push([type, payload]);
    return handler(type, payload);
  };
  return { send, calls };
}

test('an execute answer arms, presents and confirms', async () => {
  const { send, calls } = fakeSend((type) => (type === 'CONFIRM_PROPOSAL' ? { report: { completed: 1 } } : {}));
  let presented;
  const present = async (set, options) => {
    presented = { set, options };
    return { value: 'execute', label: 'Run' };
  };
  const result = await consentRound({ send, present, newId: () => 'set-1', stale: () => false }, question);
  assert.deepEqual(calls, [
    ['ARM_CONSENT', { proposalId: 'p', choiceSetId: 'set-1' }],
    ['CONFIRM_PROPOSAL', { tabId: 7, proposalId: 'p', choiceSetId: 'set-1', optionValue: 'execute' }],
  ]);
  assert.deepEqual(result, { choice: { value: 'execute', label: 'Run' }, response: { report: { completed: 1 } } });
  assert.deepEqual(presented.options, { timeoutMs: 120_000 });
  assert.equal(presented.set.question, 'Run this?');
});

test('an unanswered prompt confirms a cancel without failing', async () => {
  const { send, calls } = fakeSend((type) => {
    if (type === 'CONFIRM_PROPOSAL') throw new Error('Unknown proposal');
    return {};
  });
  const result = await consentRound({ send, present: async () => null, newId: () => 'set-1', stale: () => false }, question);
  assert.deepEqual(calls.at(-1), [
    'CONFIRM_PROPOSAL',
    { tabId: 7, proposalId: 'p', choiceSetId: 'set-1', optionValue: 'cancel' },
  ]);
  assert.deepEqual(result, { choice: null, response: {} });
});

test('a turn replaced after arming never prompts', async () => {
  const { send, calls } = fakeSend(() => ({}));
  let prompted = false;
  const present = async () => { prompted = true; return null; };
  const result = await consentRound({ send, present, newId: () => 'set-1', stale: () => true }, question);
  assert.deepEqual(result, { stale: true });
  assert.equal(prompted, false);
  assert.deepEqual(calls, [['ARM_CONSENT', { proposalId: 'p', choiceSetId: 'set-1' }]]);
});

test('a failed execute confirmation propagates', async () => {
  const error = new Error('Unknown proposal');
  const { send } = fakeSend((type) => { if (type === 'CONFIRM_PROPOSAL') throw error; return {}; });
  const present = async () => ({ value: 'execute', label: 'Run' });
  await assert.rejects(
    consentRound({ send, present, newId: () => 'set-1', stale: () => false }, question),
    (thrown) => thrown === error,
  );
});
