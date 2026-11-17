import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionQueue } from '../../extension/execution.js';

test('tasks for one tab run one at a time', async () => {
  const queue = createExecutionQueue();
  const order = [];
  const first = queue.run(1, async () => {
    order.push('a-start');
    await new Promise((resolve) => setImmediate(resolve));
    order.push('a-end');
    return 'a';
  });
  const second = queue.run(1, async () => {
    order.push('b');
    return 'b';
  });
  const a = await first;
  const b = await second;
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal(a.value, 'a');
  assert.equal(b.value, 'b');
  assert.equal(a.stopped, false);
  assert.equal(b.stopped, false);
});

test('a slow tab does not block another tab', async () => {
  const queue = createExecutionQueue();
  const order = [];
  const slow = queue.run(1, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('tab1');
    return 'one';
  });
  const fast = queue.run(2, async () => {
    order.push('tab2');
    return 'two';
  });
  assert.equal((await fast).value, 'two');
  assert.deepEqual(order, ['tab2']);
  assert.equal((await slow).value, 'one');
  assert.deepEqual(order, ['tab2', 'tab1']);
});

test('a stop cancels only the runs already queued', async () => {
  const queue = createExecutionQueue();
  const stamps = [];
  const first = queue.run(1, async () => {
    stamps.push(queue.stopped(1));
    return 'first';
  });
  const second = queue.run(1, async () => {
    stamps.push(queue.stopped(1));
    return 'second';
  });
  queue.stop(1);
  const third = queue.run(1, async () => {
    stamps.push(queue.stopped(1));
    return 'third';
  });
  assert.equal((await first).stopped, true);
  assert.equal((await second).stopped, true);
  assert.equal((await third).stopped, false);
  assert.deepEqual(stamps, [true, true, false]);
});

test('a stop with nothing queued does not latch', async () => {
  const queue = createExecutionQueue();
  queue.stop(1);
  const run = await queue.run(1, async () => 'later');
  assert.equal(run.value, 'later');
  assert.equal(run.stopped, false);
});

test('a failed task rejects its own run and the next one still runs', async () => {
  const queue = createExecutionQueue();
  const failed = queue.run(1, async () => { throw new Error('boom'); });
  await assert.rejects(failed, /boom/u);
  const next = await queue.run(1, async () => 'ok');
  assert.equal(next.value, 'ok');
  assert.equal(next.stopped, false);
});
