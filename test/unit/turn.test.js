import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurns } from '../../extension/turn.js';

test('next() ends the previous turn', () => {
  const turns = createTurns();
  const first = turns.current;
  const second = turns.next();
  assert.equal(first.stale, true);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.stale, false);
  assert.equal(turns.current, second);
});

test('cancel() ends the turn but keeps its identity', () => {
  const first = createTurns().current;
  first.cancel();
  assert.equal(first.stale, true);
  assert.equal(first.isCurrent(), true);
});

test('the abort listener fires synchronously on next()', () => {
  const turns = createTurns();
  const first = turns.current;
  let fired = false;
  first.signal.addEventListener('abort', () => { fired = true; }, { once: true });
  turns.next();
  assert.equal(fired, true);
});
