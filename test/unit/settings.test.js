import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configFingerprint,
  configOrigin,
  grantUpload,
  keyBinding,
  keyForBinding,
  needsUpload,
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
