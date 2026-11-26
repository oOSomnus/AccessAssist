import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_API_CONFIG,
  DEFAULT_CHATGPT_CONFIG,
  SCREEN_READER_CHOICES,
  keyConfigFor,
  usesChatgpt,
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

test('a refusal survives declining another site: A, then B, then back to A', () => {
  const fingerprint = configFingerprint(config);
  const first = { turn: 1 };
  const second = { turn: 2 };
  let refusals = refuseUpload(null, 'https://a.test', fingerprint, 'text', first);
  refusals = refuseUpload(refusals, 'https://b.test', fingerprint, 'text', second);
  assert.equal(refusalFor(refusals, 'https://a.test', fingerprint, 'text'), first);
  assert.equal(refusalFor(refusals, 'https://b.test', fingerprint, 'text'), second);
  // A refusal for another receiver is kept alongside, not swapped in.
  const otherFingerprint = configFingerprint({ ...config, model: 'x' });
  refusals = refuseUpload(refusals, 'https://a.test', otherFingerprint, 'text', second);
  assert.equal(refusalFor(refusals, 'https://a.test', fingerprint, 'text'), first);
  // Lifting one site leaves the other declined.
  refusals = liftRefusal(refusals, 'https://b.test', fingerprint, 'text');
  assert.equal(refusalFor(refusals, 'https://b.test', fingerprint, 'text'), null);
  assert.equal(refusalFor(refusals, 'https://a.test', fingerprint, 'text'), first);
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

test('switching to the ChatGPT plan changes the receiver but keeps the key binding', () => {
  const go = { ...DEFAULT_API_CONFIG };
  const chatgpt = { ...DEFAULT_CHATGPT_CONFIG, model: 'gpt-test' };
  assert.equal(usesChatgpt(chatgpt), true);
  assert.equal(usesChatgpt(go), false);
  // A new receiver: upload consent and the conversation must not carry over.
  assert.notEqual(configFingerprint(chatgpt), configFingerprint(go));
  assert.equal(configOrigin(chatgpt), 'https://api.openai.com');
  // The pasted key stays bound to the key-based service while ChatGPT is active.
  const custom = { ...go, baseUrl: 'https://example.test/v1' };
  assert.equal(keyConfigFor(chatgpt, custom), custom);
  assert.equal(keyConfigFor(chatgpt, null), DEFAULT_API_CONFIG);
  assert.equal(keyConfigFor(chatgpt, chatgpt), DEFAULT_API_CONFIG);
  assert.equal(keyConfigFor(go, custom), go);
  const binding = keyBinding('k', custom);
  assert.equal(keyForBinding(binding, keyConfigFor(chatgpt, custom)), 'k');
});
