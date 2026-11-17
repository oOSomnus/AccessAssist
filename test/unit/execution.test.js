import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionQueue } from '../../extension/execution.js';

function memorySession() {
  return {
    state: {},
    log: [],
    async set(values) {
      this.log.push(['set', ...Object.keys(values)]);
      Object.assign(this.state, values);
    },
    async remove(key) {
      this.log.push(['remove', key]);
      delete this.state[key];
    },
  };
}

test('tasks for one tab run one at a time', async () => {
  const queue = createExecutionQueue({ session: memorySession() });
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
  const queue = createExecutionQueue({ session: memorySession() });
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
  const queue = createExecutionQueue({ session: memorySession() });
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
  const queue = createExecutionQueue({ session: memorySession() });
  queue.stop(1);
  const run = await queue.run(1, async () => 'later');
  assert.equal(run.value, 'later');
  assert.equal(run.stopped, false);
});

test('a failed task rejects its own run and the next one still runs', async () => {
  const queue = createExecutionQueue({ session: memorySession() });
  const failed = queue.run(1, async () => { throw new Error('boom'); });
  await assert.rejects(failed, /boom/u);
  const next = await queue.run(1, async () => 'ok');
  assert.equal(next.value, 'ok');
  assert.equal(next.stopped, false);
});

test('a run writes the crash marker before the task and clears it afterwards', async () => {
  const session = memorySession();
  const queue = createExecutionQueue({ session });
  let markedDuringTask = false;
  const run = await queue.run(7, async () => {
    markedDuringTask = 'executing' in session.state;
    return 'done';
  });
  assert.equal(markedDuringTask, true);
  assert.equal(run.value, 'done');
  assert.deepEqual(session.log, [['set', 'executing'], ['remove', 'executing']]);
  assert.equal('executing' in session.state, false);
});

test('a throwing run still clears the marker', async () => {
  const session = memorySession();
  const queue = createExecutionQueue({ session });
  await assert.rejects(queue.run(1, async () => { throw new Error('boom'); }), /boom/u);
  assert.deepEqual(session.log, [['set', 'executing'], ['remove', 'executing']]);
  assert.equal('executing' in session.state, false);
});

test('unavailable session storage does not block a run', async () => {
  const session = {
    set: () => Promise.reject(new Error('quota')),
    remove: () => Promise.reject(new Error('quota')),
  };
  const queue = createExecutionQueue({ session });
  assert.equal((await queue.run(1, async () => 'ok')).value, 'ok');
});
