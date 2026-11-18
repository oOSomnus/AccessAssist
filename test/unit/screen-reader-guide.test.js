import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDES,
  SCREEN_READER_IDS,
  detectPlatform,
  guideFor,
  readerChoices,
  resolveReader,
} from '../../extension/screen-reader-guide.js';

test('every guide names its reader and gives steps', () => {
  assert.deepEqual(SCREEN_READER_IDS, ['voiceover', 'narrator', 'nvda', 'jaws']);
  for (const [id, guide] of Object.entries(GUIDES)) {
    assert.equal(typeof guide.name, 'string', id);
    assert.ok(guide.name.length > 0, id);
    assert.ok(guide.intro.length > 0, id);
    assert.ok(guide.steps.length >= 3, id);
    for (const step of guide.steps) {
      assert.equal(typeof step, 'string', id);
      // The steps are joined into one spoken utterance, so each must be a
      // finished sentence.
      assert.match(step, /[.!?”]$/u, `${id}: ${step}`);
    }
  }
});

test('a guide step never claims the extension can configure the reader', () => {
  for (const [id, guide] of Object.entries(GUIDES)) {
    const text = guide.steps.join(' ');
    assert.match(text, /cannot/u, id);
  }
});

test('detection separates macOS from Windows and admits when it cannot tell', () => {
  assert.equal(detectPlatform({ platform: 'MacIntel' }), 'voiceover');
  assert.equal(detectPlatform({ userAgentData: { platform: 'macOS' } }), 'voiceover');
  assert.equal(detectPlatform({ platform: 'Win32' }), 'narrator');
  assert.equal(detectPlatform({ userAgentData: { platform: 'Windows' } }), 'narrator');
  assert.equal(detectPlatform({ platform: 'Linux x86_64' }), null);
  assert.equal(detectPlatform(undefined), null);
});

test('a stored preference beats detection, and auto falls back to it', () => {
  const windows = { platform: 'Win32' };
  assert.equal(resolveReader('nvda', windows), 'nvda');
  assert.equal(resolveReader('jaws', windows), 'jaws');
  // A macOS user who runs something else is still believed.
  assert.equal(resolveReader('nvda', { platform: 'MacIntel' }), 'nvda');
  assert.equal(resolveReader('auto', windows), 'narrator');
  assert.equal(resolveReader(undefined, windows), 'narrator');
  assert.equal(resolveReader('', windows), 'narrator');
  // An unknown value must not become a guide lookup miss.
  assert.equal(resolveReader('orca', windows), 'narrator');
  assert.equal(resolveReader('auto', { platform: 'Linux x86_64' }), null);
});

test('candidate readers reflect what the platform can actually narrow', () => {
  // macOS needs no question; Windows cannot be narrowed past three.
  assert.deepEqual(readerChoices('voiceover'), ['voiceover']);
  assert.deepEqual(readerChoices('narrator'), ['narrator', 'nvda', 'jaws']);
  assert.deepEqual(readerChoices(null), SCREEN_READER_IDS);
  for (const id of readerChoices(null)) assert.ok(guideFor(id), id);
});

test('guideFor returns null rather than throwing on an unknown reader', () => {
  assert.equal(guideFor('orca'), null);
  assert.equal(guideFor(null), null);
  assert.equal(guideFor(undefined), null);
});
