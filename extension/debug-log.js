// In-memory session log for the side panel. Entries are redacted when added so
// screenshots and the API key never sit in memory, and every entry is redacted
// again on export so a key typed after an event is still scrubbed.

export const DEBUG_LOG_LIMIT = 2000;

const SECRET_KEYS = new Set(['apikey', 'authorization', 'x-api-key']);
const MAX_STRING = 20_000;
const MAX_DEPTH = 20;
const DATA_URL = /^data:image\//u;

function redactString(text, secrets) {
  let value = text;
  for (const secret of secrets) {
    if (secret) value = value.replaceAll(secret, '[redacted]');
  }
  if (DATA_URL.test(value)) return `[screenshot omitted, ${value.length} chars]`;
  if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`;
  return value;
}

export function redact(value, secrets = [], depth = 0) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (value instanceof Error) {
    return {
      name: redactString(value.name ?? 'Error', secrets),
      message: redactString(value.message ?? '', secrets),
      code: redact(value.code, secrets, depth + 1),
      stack: value.stack ? redactString(value.stack, secrets) : undefined,
    };
  }
  if (Array.isArray(value) || value instanceof Set) {
    return [...value].map((item) => redact(item, secrets, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const name = redactString(key, secrets);
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[name] = '[redacted]';
    } else if (key === 'data' && value.type === 'image' && typeof item === 'string') {
      out[name] = `[screenshot omitted, ${item.length} base64 chars]`;
    } else {
      out[name] = redact(item, secrets, depth + 1);
    }
  }
  return out;
}

export function createDebugLog({ limit = DEBUG_LOG_LIMIT, secrets = () => [], now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const events = [];
  let dropped = 0;
  return {
    add(kind, data = {}) {
      events.push({ at: now().toISOString(), kind, data: redact(data, secrets()) });
      if (events.length > limit) {
        events.shift();
        dropped += 1;
      }
    },
    report(snapshot = {}) {
      return {
        format: 'accessassist-debug-log/1',
        startedAt,
        droppedEvents: dropped,
        ...redact(snapshot, secrets()),
        events: redact(events, secrets()),
      };
    },
  };
}
