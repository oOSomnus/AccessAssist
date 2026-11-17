// Build accessassist.zip in an owned directory next to the destination and
// swap it in only after zip succeeds, so a failed run keeps the last archive.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'extension');
const destination = path.join(root, 'accessassist.zip');
let temp = null;

let finished = false;
const cleanup = () => {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
};
const fail = (message) => {
  if (finished) return;
  finished = true;
  cleanup();
  console.error(message);
  process.exitCode = 1;
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

try {
  temp = fs.mkdtempSync(path.join(root, '.accessassist-package-'));
  const archive = path.join(temp, 'accessassist.zip');
  execFileSync('zip', ['-qrX', archive, '.', '-x', '__MACOSX/*', '-x', '*.DS_Store'], {
    cwd: extension,
    stdio: 'pipe',
  });
  fs.renameSync(archive, destination);
} catch {
  fail('Packaging failed; accessassist.zip was not changed');
}

if (!finished) {
  finished = true;
  cleanup();
}
