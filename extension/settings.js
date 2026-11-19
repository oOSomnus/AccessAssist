export const DEFAULT_API_CONFIG = Object.freeze({
  protocol: 'openai',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  model: 'deepseek-v4.1-flash',
  anthropicVersion: '2026-10-21',
  effort: 'default',
});

// Kept out of apiConfig on purpose: configOrigin and configFingerprint hash
// that object, so an extra field there would clear the session key and upload
// consent every time this preference changed.
export const SCREEN_READER_CHOICES = Object.freeze(['auto', 'narrator', 'nvda', 'jaws', 'voiceover']);

export function normalizeScreenReader(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SCREEN_READER_CHOICES.includes(value) ? value : 'auto';
}

export function configOrigin(config) {
  try {
    return new URL(config.baseUrl).origin;
  } catch {
    return '';
  }
}

export function configFingerprint(config) {
  return [config.protocol, config.baseUrl, config.model, config.anthropicVersion ?? ''].join('|');
}

export function keyBinding(apiKey, config) {
  return { value: String(apiKey), origin: configOrigin(config), at: Date.now() };
}

export function keyForBinding(stored, config) {
  if (!stored?.value || stored.origin !== configOrigin(config)) return null;
  return stored.value;
}

export function uploadConsentFor(existing, pageOrigin, fingerprint) {
  if (!existing) return null;
  if (existing.pageOrigin !== pageOrigin || existing.fingerprint !== fingerprint) return null;
  return existing;
}

export function grantUpload(existing, pageOrigin, fingerprint, part) {
  const base = uploadConsentFor(existing, pageOrigin, fingerprint)
    ?? { pageOrigin, fingerprint, text: false, image: false };
  return { ...base, [part]: true };
}

export function needsUpload(consent, part) {
  return !consent || consent[part] !== true;
}

// A refusal mirrors consent: it belongs to one page origin and one receiver
// configuration, and each part (text, image) is refused on its own. The marker
// records which turn refused, so a later turn can tell it apart.
export function refusalFor(existing, pageOrigin, fingerprint, part) {
  if (!existing || existing.pageOrigin !== pageOrigin || existing.fingerprint !== fingerprint) return null;
  return existing[part] ?? null;
}

export function refuseUpload(existing, pageOrigin, fingerprint, part, marker) {
  const base = existing && existing.pageOrigin === pageOrigin && existing.fingerprint === fingerprint
    ? existing
    : { pageOrigin, fingerprint, text: null, image: null };
  return { ...base, [part]: marker };
}

export function liftRefusal(existing, pageOrigin, fingerprint, part) {
  if (!refusalFor(existing, pageOrigin, fingerprint, part)) return existing;
  return { ...existing, [part]: null };
}
