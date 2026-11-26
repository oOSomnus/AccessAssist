import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startFixtures } from '../serve-fixtures.mjs';
import { isMain, protocolSelectionError, selectProtocols } from '../../scripts/live-check.mjs';
import { oracleOk, panelSettled, terminalSuccess } from '../../scripts/when2meet-oracle.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIAGNOSTIC_HEADERS = { 'x-aa-node-test': 'accessassist-fixtures' };
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

const base = (fixtures, which = 'api') => `http://127.0.0.1:${fixtures[`${which}Port`]}`;

function modelBody(overrides = {}) {
  return JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'event schedule page about the second paragraph' }],
    ...overrides,
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function rawPost(port, { headers, chunks, end = true, pathName = '/v1/chat/completions' }) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      req.destroy();
      resolve(value);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers,
    }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    });
    guard = setTimeout(() => finish({ status: 0, body: '' }), 3000);
    guard.unref?.();
    req.on('error', () => finish({ status: 0, body: '' }));
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
  });
}

function packageMembers(project) {
  return execFileSync('unzip', ['-Z1', 'accessassist.zip'], { cwd: project, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function runPackager(project) {
  execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: project, encoding: 'utf8' });
}

function envWithoutKey(extra = {}) {
  const env = { ...process.env };
  delete env.OPENCODE_ACCESS_KEY;
  delete env.ONLY_PROTOCOL;
  return { ...env, ...extra };
}

test('regression: fixtures bind ephemeral ports, resolve the API origin, and close', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 1024, bodyTimeoutMs: 200 });
  try {
    assert.ok(fixtures.pagePort > 0);
    assert.ok(fixtures.apiPort > 0);
    assert.notEqual(fixtures.pagePort, fixtures.apiPort);
    assert.equal(await (await fetch(`${base(fixtures, 'page')}/health`)).text(), 'ok');
    assert.equal(await (await fetch(`${base(fixtures)}/health`)).text(), 'ok');
    const page = await (await fetch(`${base(fixtures, 'page')}/images`)).text();
    assert.match(page, new RegExp(`127\\.0\\.0\\.1:${fixtures.apiPort}/cross\\.svg`));
    assert.doesNotMatch(page, /127\.0\.0\.1:4174/);
  } finally {
    await fixtures.close();
  }
  assert.equal(fixtures.pageServer.listening, false);
  assert.equal(fixtures.apiServer.listening, false);
  await fixtures.close();
});

test('regression: a fixture bind failure closes the other listener', async () => {
  const occupied = http.createServer();
  const pagePort = await listen(occupied);
  const probe = http.createServer();
  const apiPort = await listen(probe);
  await close(probe);
  try {
    await assert.rejects(
      startFixtures({ pagePort, apiPort, maxBodyBytes: 1024, bodyTimeoutMs: 200 }),
      (error) => error.code === 'EADDRINUSE',
    );
    const rebound = http.createServer();
    await listen(rebound, apiPort);
    await close(rebound);
  } finally {
    await close(occupied);
  }
});

test('regression: fixture logs and tool counters are per instance', async () => {
  const first = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 1024, bodyTimeoutMs: 200 });
  const second = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 1024, bodyTimeoutMs: 200 });
  try {
    const response = await fetch(`${base(first)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: modelBody(),
    });
    assert.equal(response.status, 200);
    const firstLog = await (await fetch(`${base(first)}/requests`, { headers: DIAGNOSTIC_HEADERS })).json();
    const secondLog = await (await fetch(`${base(second)}/requests`, { headers: DIAGNOSTIC_HEADERS })).json();
    assert.equal(firstLog.length, 1);
    assert.equal(secondLog.length, 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('regression: diagnostics reject browsers and wrong methods without CORS', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 1024, bodyTimeoutMs: 200 });
  try {
    const api = base(fixtures);
    assert.equal((await fetch(`${api}/requests`)).status, 403);
    assert.equal((await fetch(`${api}/requests`, {
      headers: { ...DIAGNOSTIC_HEADERS, origin: EXTENSION_ORIGIN },
    })).status, 403);
    assert.equal((await fetch(`${api}/requests`, {
      headers: { ...DIAGNOSTIC_HEADERS, 'sec-fetch-site': 'cross-site' },
    })).status, 403);
    assert.equal((await fetch(`${api}/requests`, {
      headers: { ...DIAGNOSTIC_HEADERS, 'sec-fetch-site': 'same-site' },
    })).status, 403);
    assert.equal((await fetch(`${api}/requests`, {
      headers: { ...DIAGNOSTIC_HEADERS, cookie: 'session=secret' },
    })).status, 403);
    assert.equal((await fetch(`${api}/requests`, { method: 'POST', headers: DIAGNOSTIC_HEADERS })).status, 405);
    assert.equal((await fetch(`${api}/reset`, { headers: DIAGNOSTIC_HEADERS })).status, 405);
    const allowed = await fetch(`${api}/requests`, { headers: DIAGNOSTIC_HEADERS });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), null);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await fixtures.close();
  }
});

test('regression: model routes reflect only extension origins', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 4096, bodyTimeoutMs: 200 });
  try {
    const api = base(fixtures);
    const body = modelBody();
    const foreign = await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);

    const foreignPreflight = await fetch(`${api}/v1/messages`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(foreignPreflight.status, 403);
    assert.equal(foreignPreflight.headers.get('access-control-allow-origin'), null);

    const accepted = await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);
    assert.match(accepted.headers.get('vary') ?? '', /Origin/i);
    assert.notEqual(accepted.headers.get('access-control-allow-origin'), '*');

    const preflight = await fetch(`${api}/v1/messages`, {
      method: 'OPTIONS',
      headers: {
        origin: EXTENSION_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/);
    assert.doesNotMatch(preflight.headers.get('access-control-allow-methods') ?? '', /GET/);
  } finally {
    await fixtures.close();
  }
});

test('regression: request logs keep bodies but redact credentials', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 4096, bodyTimeoutMs: 200 });
  try {
    const api = base(fixtures);
    const body = modelBody();
    await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-key',
        'x-api-key': 'number-key',
        cookie: 'session=cookie-secret',
      },
      body,
    });
    await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Custom arbitrary-scheme' },
      body,
    });
    await fetch(`${api}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic dXNlcjpwYXNz' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    const log = await (await fetch(`${api}/requests`, { headers: DIAGNOSTIC_HEADERS })).json();
    assert.equal(log.length, 3);
    assert.equal(log[0].authorization, 'Bearer [redacted]');
    assert.equal(log[0].apiKeyPresent, true);
    assert.equal(log[0].cookiePresent, true);
    assert.equal('apiKey' in log[0], false);
    assert.deepEqual(log[0].body, JSON.parse(body));
    assert.equal(log[0].path, '/v1/chat/completions');
    assert.equal(log[0].protocol, 'openai');
    assert.equal(log[1].authorization, '[redacted]');
    assert.equal(log[2].authorization, 'Basic [redacted]');
    const serialized = JSON.stringify(log);
    for (const secret of ['super-secret-key', 'cookie-secret', 'number-key', 'dXNlcjpwYXNz', 'arbitrary-scheme']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  } finally {
    await fixtures.close();
  }
});

test('regression: reset rejects browser origins and re-arms the tool counter', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 4096, bodyTimeoutMs: 200 });
  try {
    const api = base(fixtures);
    const post = () => fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: modelBody(),
    }).then((response) => response.json());
    const first = await post();
    assert.equal(first.choices[0].message.tool_calls[0].id, 'call_1');

    const rejected = await fetch(`${api}/reset`, {
      method: 'POST',
      headers: { ...DIAGNOSTIC_HEADERS, origin: EXTENSION_ORIGIN },
    });
    assert.equal(rejected.status, 403);
    const stillLogged = await (await fetch(`${api}/requests`, { headers: DIAGNOSTIC_HEADERS })).json();
    assert.equal(stillLogged.length, 1);

    const reset = await fetch(`${api}/reset`, { method: 'POST', headers: DIAGNOSTIC_HEADERS });
    assert.equal(reset.status, 200);
    assert.equal((await (await fetch(`${api}/requests`, { headers: DIAGNOSTIC_HEADERS })).json()).length, 0);

    const second = await post();
    assert.equal(second.choices[0].message.tool_calls[0].id, 'call_1');
  } finally {
    await fixtures.close();
  }
});

test('regression: model bodies are bounded and malformed requests recover', async () => {
  const fixtures = await startFixtures({ pagePort: 0, apiPort: 0, maxBodyBytes: 128, bodyTimeoutMs: 150 });
  try {
    const api = base(fixtures);
    const body = JSON.stringify({ model: 'test-model', messages: [] });
    const exact = body + ' '.repeat(128 - Buffer.byteLength(body));
    assert.equal(Buffer.byteLength(exact), 128);
    const accepted = await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: exact,
    });
    assert.equal(accepted.status, 200);

    const over = await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `${exact} `,
    });
    assert.equal(over.status, 413);
    assert.equal(await over.text(), '{"error":"request too large"}');

    const streamed = await rawPost(fixtures.apiPort, {
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      chunks: ['x'.repeat(100), 'y'.repeat(100)],
    });
    assert.equal(streamed.status, 413);

    const stalled = await rawPost(fixtures.apiPort, {
      headers: { 'content-type': 'application/json', 'content-length': '100' },
      chunks: ['{"model":'],
      end: false,
    });
    assert.equal(stalled.status, 408);

    for (const malformed of ['{oops', 'null', '[]', '{"messages":"no"}', '{"messages":[5]}']) {
      const response = await fetch(`${api}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: malformed,
      });
      assert.equal(response.status, 400, malformed);
      assert.equal(await response.text(), '{"error":"invalid request"}');
    }
    assert.equal(await (await fetch(`${api}/health`)).text(), 'ok');
    const normalizeFailure = await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"m","messages":[{"role":"user","content":5}]}',
    });
    assert.equal(normalizeFailure.status, 400);
    assert.equal(await normalizeFailure.text(), '{"error":"invalid request"}');
    assert.equal((await fetch(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })).status, 200);
  } finally {
    await fixtures.close();
  }
});

test('regression: packaging rebuilds a clean archive and preserves the last good one', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-package-'));
  const extension = path.join(project, 'extension');
  const archive = path.join(project, 'accessassist.zip');
  try {
    fs.mkdirSync(path.join(project, 'scripts'));
    fs.mkdirSync(extension);
    fs.copyFileSync(path.join(ROOT, 'scripts/package.mjs'), path.join(project, 'scripts/package.mjs'));
    fs.writeFileSync(path.join(extension, 'manifest.json'), '{"manifest_version":3,"name":"t","version":"1"}');
    fs.writeFileSync(path.join(extension, 'removeme.txt'), 'stale\n');

    runPackager(project);
    assert.ok(packageMembers(project).includes('manifest.json'));
    assert.ok(packageMembers(project).includes('removeme.txt'));

    fs.rmSync(path.join(extension, 'removeme.txt'));
    runPackager(project);
    const rebuilt = packageMembers(project);
    assert.ok(rebuilt.includes('manifest.json'));
    assert.equal(rebuilt.includes('removeme.txt'), false);

    const before = fs.readFileSync(archive);
    fs.renameSync(extension, `${extension}-gone`);
    const failure = spawnSync(process.execPath, ['scripts/package.mjs'], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /Packaging failed; accessassist\.zip was not changed/);
    assert.deepEqual(fs.readFileSync(archive), before);
    assert.equal(fs.readdirSync(project).some((name) => name.startsWith('.accessassist-package-')), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('regression: ONLY_PROTOCOL selects one known protocol and keeps both when absent', () => {
  const entries = [{ name: 'openai' }, { name: 'anthropic' }];
  const saved = process.env.ONLY_PROTOCOL;
  try {
    delete process.env.ONLY_PROTOCOL;
    assert.deepEqual(selectProtocols(entries, undefined), entries);
    assert.deepEqual(selectProtocols(entries, ''), entries);
    assert.deepEqual(selectProtocols(entries, 'anthropic'), [{ name: 'anthropic' }]);
    assert.equal(selectProtocols(entries, 'bogus'), null);
    process.env.ONLY_PROTOCOL = 'anthropic';
    assert.deepEqual(selectProtocols(entries), [{ name: 'anthropic' }]);
  } finally {
    if (saved === undefined) delete process.env.ONLY_PROTOCOL;
    else process.env.ONLY_PROTOCOL = saved;
  }
  assert.equal(protocolSelectionError(), 'ONLY_PROTOCOL must be one of: openai, anthropic, chatgpt');
  assert.equal(isMain(new URL('../../scripts/live-check.mjs', import.meta.url).href, ''), false);
});

test('regression: live checks reject an invalid protocol before reading the key', () => {
  for (const script of ['scripts/smoke-ai.mjs', 'scripts/verify-when2meet.mjs']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      env: envWithoutKey({ ONLY_PROTOCOL: 'bogus' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, script);
    assert.match(result.stderr, /ONLY_PROTOCOL must be one of: openai, anthropic/, script);
  }
  const noKey = spawnSync(process.execPath, ['scripts/smoke-ai.mjs'], {
    cwd: ROOT,
    env: envWithoutKey(),
    encoding: 'utf8',
  });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /Missing OPENCODE_ACCESS_KEY/);
});

test('regression: live check modules import without running', async () => {
  const smoke = await import('../../scripts/smoke-ai.mjs');
  const verify = await import('../../scripts/verify-when2meet.mjs');
  assert.equal(typeof smoke.insideTarget, 'function');
  assert.equal(smoke.insideTarget({ x: 113, y: 20 }, { x: 120, y: 10, width: 90, height: 30 }), false);
  assert.equal(smoke.insideTarget({ x: 165, y: 25 }, { x: 120, y: 10, width: 90, height: 30 }), true);
  assert.equal(typeof verify.oracleOk, 'function');
  assert.equal(typeof verify.terminalSuccess, 'function');
});

test('regression: a failed auto-install launch removes its profile directory', async () => {
  const { runInstall } = await import('../../aa-install-auto.mjs');
  let profile = null;
  await assert.rejects(runInstall({
    launch: async (dir) => {
      profile = dir;
      assert.ok(fs.existsSync(dir));
      throw new Error('launch failed');
    },
  }), /launch failed/);
  assert.ok(profile);
  assert.equal(fs.existsSync(profile), false);
});

test('regression: when2meet oracle compares against populated baseline values', () => {
  const baseline = {
    name: 'Team sync',
    notBefore: '9:00 AM',
    notAfter: '5:00 PM',
    zone: 'America/New_York',
    url: 'https://www.when2meet.com/',
  };
  const oracle = {
    mode: 'DaysOfTheWeek',
    dates: '1|3',
    chosen: ['1', '3'],
    ...baseline,
  };
  assert.equal(oracleOk(oracle, baseline, []), true);
  assert.equal(oracleOk({ ...oracle, chosen: ['1', '2', '3'], dates: '1|2|3' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, chosen: ['1'], dates: '1' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, name: 'Changed' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, notBefore: '10:00 AM' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, notAfter: '6:00 PM' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, zone: 'Europe/London' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, url: 'https://www.when2meet.com/?other=1' }, baseline, []), false);
  assert.equal(oracleOk({ ...oracle, mode: 'Dates' }, baseline, []), false);
  assert.equal(oracleOk(oracle, baseline, ['https://www.when2meet.com/SaveNewEvent.php']), false);
  assert.equal(panelSettled('true'), false);
  assert.equal(panelSettled('false'), true);
  assert.equal(terminalSuccess({ busy: 'false', oracle }, baseline, []), true);
  assert.equal(terminalSuccess({ busy: 'true', oracle }, baseline, []), false);
  assert.equal(terminalSuccess({ busy: null, oracle }, baseline, []), false);
});
