import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREEN_READER_CHOICES,
  configFingerprint,
  configOrigin,
  grantUpload,
  keyBinding,
  keyForBinding,
  liftRefusal,
  needsUpload,
  normalizeScreenReader,
  refuseUpload,
  refusalFor,
  uploadConsentFor,
} from '../../extension/settings.js';

const config = { protocol: 'openai', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'm' };
const other = { ...config, baseUrl: 'https://gateway.test/v1' };

test('keys are bound to the full API origin', () => {
  const binding = keyBinding('secret', config);
  assert.equal(binding.origin, 'https://opencode.ai');
  assert.equal(keyForBinding(binding, config), 'secret');
  assert.equal(keyForBinding(binding, other), null);
  assert.equal(keyForBinding(null, config), null);
  assert.equal(keyForBinding({ value: 'x', origin: 'https://opencode.ai' }, { ...config, model: 'other' }), 'x');
});

test('a different scheme or port is a different API receiver', () => {
  const binding = keyBinding('secret', { ...config, baseUrl: 'http://opencode.ai/inference/go/openai/v1' });
  assert.equal(binding.origin, 'http://opencode.ai');
  assert.equal(keyForBinding(binding, config), null);
  const ported = keyBinding('secret', { ...config, baseUrl: 'https://opencode.ai:8443/inference/go/openai/v1' });
  assert.equal(keyForBinding(ported, config), null);
  assert.equal(keyForBinding({ value: 'secret', origin: 'opencode.ai', at: 1 }, config), null);
  assert.equal(configOrigin({ baseUrl: 'not a url' }), '');
});

test('upload consent is per page origin and API configuration', () => {
  const fingerprint = configFingerprint(config);
  assert.equal(configOrigin(config), 'https://opencode.ai');
  assert.equal(needsUpload(null, 'text'), true);
  let consent = grantUpload(null, 'https://example.test', fingerprint, 'text');
  assert.equal(needsUpload(uploadConsentFor(consent, 'https://example.test', fingerprint), 'text'), false);
  assert.equal(needsUpload(uploadConsentFor(consent, 'https://example.test', fingerprint), 'image'), true);
  assert.equal(uploadConsentFor(consent, 'https://other.test', fingerprint), null);
  consent = grantUpload(consent, 'https://example.test', fingerprint, 'image');
  assert.equal(needsUpload(consent, 'image'), false);
  const changedFingerprint = configFingerprint({ ...config, model: 'different' });
  assert.equal(uploadConsentFor(consent, 'https://example.test', changedFingerprint), null);
});

test('an upload refusal is per page origin, API configuration and part', () => {
  const fingerprint = configFingerprint(config);
  assert.equal(refusalFor(null, 'https://example.test', fingerprint, 'text'), null);
  const marker = { turn: 1 };
  let refusal = refuseUpload(null, 'https://example.test', fingerprint, 'text', marker);
  assert.equal(refusalFor(refusal, 'https://example.test', fingerprint, 'text'), marker);
  assert.equal(refusalFor(refusal, 'https://example.test', fingerprint, 'image'), null);
  assert.equal(refusalFor(refusal, 'https://other.test', fingerprint, 'text'), null);
  assert.equal(refusalFor(refusal, 'https://example.test', configFingerprint({ ...config, model: 'x' }), 'text'), null);
  refusal = refuseUpload(refusal, 'https://example.test', fingerprint, 'image', marker);
  assert.equal(refusalFor(refusal, 'https://example.test', fingerprint, 'image'), marker);
  refusal = liftRefusal(refusal, 'https://example.test', fingerprint, 'text');
  assert.equal(refusalFor(refusal, 'https://example.test', fingerprint, 'text'), null);
  assert.equal(refusalFor(refusal, 'https://example.test', fingerprint, 'image'), marker);
  // A refusal for another site is not touched by lifting this one.
  assert.equal(liftRefusal(refusal, 'https://other.test', fingerprint, 'image'), refusal);
});

test('the screen-reader preference accepts only known readers', () => {
  assert.deepEqual(SCREEN_READER_CHOICES, ['auto', 'narrator', 'nvda', 'jaws', 'voiceover']);
  for (const value of SCREEN_READER_CHOICES) assert.equal(normalizeScreenReader(value), value);
  assert.equal(normalizeScreenReader('NVDA'), 'nvda');
  assert.equal(normalizeScreenReader('  jaws  '), 'jaws');
  // Anything unrecognized falls back to detection rather than to a guide miss.
  assert.equal(normalizeScreenReader('orca'), 'auto');
  assert.equal(normalizeScreenReader(undefined), 'auto');
  assert.equal(normalizeScreenReader(null), 'auto');
  assert.equal(normalizeScreenReader(7), 'auto');
  assert.equal(normalizeScreenReader(''), 'auto');
});

test('the screen-reader preference is not part of the API fingerprint', () => {
  // Folding it into apiConfig would clear the session key whenever it changed.
  const before = configFingerprint(config);
  assert.equal(configFingerprint({ ...config, screenReader: 'nvda' }), before);
});
