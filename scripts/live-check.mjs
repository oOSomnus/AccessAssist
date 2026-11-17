// Shared guards for the manual live checks. Importing these modules must not
// read a key, open a browser or call a model; each script runs only as main.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOLS = ['openai', 'anthropic'];

// Returns the selected entries, or null when ONLY_PROTOCOL names no protocol.
export function selectProtocols(entries, only = process.env.ONLY_PROTOCOL) {
  if (!only) return entries;
  const selected = entries.filter((entry) => entry.name === only);
  return selected.length > 0 ? selected : null;
}

export function protocolSelectionError() {
  return `ONLY_PROTOCOL must be one of: ${PROTOCOLS.join(', ')}`;
}

export function checkError(code) {
  const error = new Error(code);
  error.code = 'AA_CHECK';
  return error;
}

export function isMain(moduleUrl, argv = process.argv[1]) {
  return Boolean(argv) && fileURLToPath(moduleUrl) === path.resolve(argv);
}
