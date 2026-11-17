import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugLog, redact } from '../../extension/debug-log.js';

test('redact removes secrets, screenshots and oversized strings', () => {
  const out = redact({
    headers: { authorization: 'Bearer x' },
    apiKey: 'y',
    note: 'key sk-secret-1 echoed',
    content: [{ type: 'image', data: 'A'.repeat(50) }],
    shot: 'data:image/png;base64,AAAA',
    big: 'x'.repeat(25_000),
    set: new Set(['a']),
  }, ['sk-secret-1']);
  assert.equal(out.headers.authorization, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.note, 'key [redacted] echoed');
  assert.equal(out.content[0].data, '[screenshot omitted, 50 base64 chars]');
  assert.equal(out.content[0].type, 'image');
  assert.equal(out.shot.startsWith('[screenshot omitted, '), true);
  assert.equal(out.big, `${'x'.repeat(20_000)}…[truncated 5000 chars]`);
  assert.deepEqual(out.set, ['a']);
});

test('the ring buffer keeps the newest entries and counts drops', () => {
  const log = createDebugLog({ limit: 3 });
  for (const kind of ['a', 'b', 'c', 'd', 'e']) log.add(kind);
  const report = log.report({});
  assert.deepEqual(report.events.map((event) => event.kind), ['c', 'd', 'e']);
  assert.equal(report.droppedEvents, 2);
  assert.equal(report.format, 'accessassist-debug-log/1');
});

test('a secret added after an event is still redacted on export', () => {
  let key = null;
  const log = createDebugLog({ secrets: () => [key] });
  log.add('typed', { text: 'sk-late' });
  key = 'sk-late';
  assert.equal(JSON.stringify(log.report({ apiKey: 'sk-late' })).includes('sk-late'), false);
});

test('cycles stop at the depth limit instead of overflowing', () => {
  const loop = { name: 'loop' };
  loop.self = loop;
  const out = redact(loop);
  assert.equal(out.name, 'loop');
  assert.equal(out.self.self.self.name, 'loop');
});

test('secrets are removed from property names and error codes', () => {
  const error = Object.assign(new Error('boom'), { code: 'bad key sk-secret-1' });
  const out = redact({ 'sk-secret-1': { apiKey: 'y' }, numbered: Object.assign(new Error('x'), { code: 429 }), error }, ['sk-secret-1']);
  assert.equal(JSON.stringify(out).includes('sk-secret-1'), false);
  assert.equal(out['[redacted]'].apiKey, '[redacted]');
  assert.equal(out.error.code, 'bad key [redacted]');
  assert.equal(out.numbered.code, 429);
});
