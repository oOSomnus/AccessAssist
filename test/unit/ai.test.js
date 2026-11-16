import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  buildHeaders,
  endpointFor,
  isGoConfig,
  normalizeConfig,
  plainText,
  requestTurn,
} from '../../extension/ai.js';

const goOpenAI = { ...DEFAULT_CONFIG };
const goAnthropic = {
  protocol: 'anthropic',
  baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
  model: 'deepseek-v4.1-flash',
  anthropicVersion: '2026-10-21',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('config validation accepts defaults and rejects unsafe URLs', () => {
  const normalized = normalizeConfig(goOpenAI);
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.config.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'http://example.com/v1' }).errors[0], 'HTTP is only allowed for localhost; other addresses must use HTTPS');
  assert.match(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'https://user:pass@example.com/v1' }).errors[0], /username or password/u);
  assert.match(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'https://example.com/v1/chat/completions' }).errors[0], /do not include/u);
  assert.match(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'https://example.com/v1?x=1' }).errors[0], /query or fragment/u);
  assert.equal(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:4174/v1' }).errors.length, 0);
  assert.equal(normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'https://example.com/v1/' }).config.baseUrl, 'https://example.com/v1');
  assert.match(normalizeConfig({ ...goAnthropic, anthropicVersion: 'latest' }).errors[0], /YYYY-MM-DD/u);
  assert.equal(normalizeConfig({ ...goAnthropic, anthropicVersion: '' }).errors.length, 1);
});

test('endpoints and headers follow each protocol', () => {
  const openai = normalizeConfig(goOpenAI).config;
  assert.equal(endpointFor(openai), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  const anthropic = normalizeConfig(goAnthropic).config;
  assert.equal(endpointFor(anthropic), 'https://opencode.ai/inference/go/anthropic/v1/messages');
  assert.equal(isGoConfig(anthropic), true);
  assert.equal(isGoConfig({ ...anthropic, baseUrl: 'https://opencode.ai.evil.test/inference/go/anthropic/v1' }), false);

  const goHeaders = buildHeaders(anthropic, 'k', 'session-1');
  assert.equal(goHeaders.authorization, 'Bearer k');
  assert.equal(goHeaders['x-opencode-session'], 'session-1');
  assert.equal(goHeaders['x-api-key'], undefined);

  const custom = { ...anthropic, baseUrl: 'https://gateway.test/anthropic/v1' };
  const customHeaders = buildHeaders(custom, 'k', 'session-1');
  assert.equal(customHeaders['x-api-key'], 'k');
  assert.equal(customHeaders['anthropic-version'], '2026-10-21');
  assert.equal(customHeaders['x-opencode-session'], undefined);

  const official = { ...custom, baseUrl: 'https://api.anthropic.com/v1' };
  assert.equal(buildHeaders(official, 'k', 's')['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(buildHeaders({ ...goOpenAI, protocol: 'openai', baseUrl: 'https://example.test/v1' }, 'k', 's').authorization, 'Bearer k');
});

test('OpenAI body keeps tool results, reasoning and images', async () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' }).config;
  let sent;
  await requestTurn({
    config,
    apiKey: 'k',
    sessionId: 's',
    system: 'You are an assistant',
    maxTokens: 777,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: 'AAA' }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'observe_page', args: {} }], raw: { reasoning_content: 'Think first' } },
      { role: 'tool', results: [{ id: 'call_1', content: '{"ok":true}', isError: false }] },
    ],
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  assert.equal(sent.stream, false);
  assert.equal(sent.max_tokens, 777);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content, 'You are an assistant');
  assert.equal(sent.messages[1].role, 'user');
  assert.equal(sent.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(sent.messages[2].tool_calls[0].id, 'call_1');
  assert.equal(sent.messages[2].tool_calls[0].function.arguments, '{}');
  assert.equal(sent.messages[2].reasoning_content, 'Think first');
  assert.deepEqual(sent.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
  assert.equal(sent.tools[0].type, 'function');
  assert.equal(sent.tools[0].function.name, 'observe_page');
});

test('Anthropic body uses top-level system, input_schema and native blocks', async () => {
  const config = normalizeConfig(goAnthropic).config;
  const rawBlocks = [
    { type: 'thinking', thinking: 'Think it through', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: { question: 'q', options: [] } },
  ];
  let sent;
  await requestTurn({
    config,
    apiKey: 'k',
    sessionId: 's',
    system: 'You are an assistant',
    maxTokens: 777,
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_1', name: 'ask_user', args: {} }], raw: { provider: 'anthropic', content: rawBlocks } },
      { role: 'tool', results: [{ id: 'toolu_1', content: 'The user chose PM', isError: false }] },
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }] },
    ],
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { opencode: { billing_source: 'go' } } });
    },
  });
  assert.equal(sent.system, 'You are an assistant');
  assert.equal(sent.max_tokens, 777);
  assert.equal(sent.stream, false);
  assert.equal(sent.messages[0].content[0].text, 'Hello');
  assert.deepEqual(sent.messages[1].content, rawBlocks);
  assert.equal(sent.messages[2].content[0].type, 'tool_result');
  assert.equal(sent.messages[2].content[0].tool_use_id, 'toolu_1');
  assert.equal(sent.messages[3].content[0].source.data, 'AAA');
  assert.equal(sent.tools[0].input_schema.type, 'object');
  assert.equal(sent.tools[0].function, undefined);
});

test('OpenAI responses are parsed and Go billing is enforced', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return json({
      choices: [{ message: { content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'observe_page', arguments: '{"cursor":"2"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { opencode: { billing_source: 'go' } },
    });
  };
  const result = await requestTurn({
    config: goOpenAI, apiKey: 'secret', sessionId: 's', system: 'sys', messages: [{ role: 'user', content: 'Read the page' }], fetchImpl: fakeFetch,
  });
  assert.equal(result.toolCalls[0].args.cursor, '2');
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['x-opencode-session'], 's');

  await assert.rejects(
    requestTurn({
      config: goOpenAI, apiKey: 'secret', sessionId: 's', system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ choices: [{ message: { content: 'hi' } }], usage: { opencode: { billing_source: 'balance' } } }),
    }),
    (error) => error.code === 'billing',
  );
});

test('Anthropic responses keep blocks and reject truncation', async () => {
  const body = {
    content: [
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'toolu_2', name: 'observe_page', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: { opencode: { billing_source: 'go-plus' } },
  };
  const result = await requestTurn({
    config: goAnthropic, apiKey: 'k', sessionId: 's', system: 'sys', messages: [{ role: 'user', content: 'Read it' }],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://opencode.ai/inference/go/anthropic/v1/messages');
      assert.equal(init.headers['x-api-key'], undefined);
      assert.equal(JSON.parse(init.body).system, 'sys');
      return json(body);
    },
  });
  assert.equal(result.text, 'I will read it.');
  assert.equal(result.toolCalls[0].id, 'toolu_2');
  assert.equal(result.raw.content.length, 2);

  await assert.rejects(
    requestTurn({
      config: goAnthropic, apiKey: 'k', sessionId: 's', system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ content: [{ type: 'text', text: 'Half a sentence' }], stop_reason: 'max_tokens' }),
    }),
    (error) => error.code === 'truncated' && /Go/u.test(error.message) === false,
  );
});

test('markdown is removed from visible text without damaging ordinary values', () => {
  assert.equal(plainText('## Title\n- one\n- two'), 'Title\none\ntwo');
  assert.equal(
    plainText('Use **bold** and `code`. See [docs](https://example.test/docs).'),
    'Use bold and code. See docs (https://example.test/docs).',
  );
  assert.equal(plainText('| A | B |\n| --- | --- |\n| 1 | 2 |'), 'A B\n1 2');
  assert.equal(plainText('The balance is -12.50 and user_id stays.'), 'The balance is -12.50 and user_id stays.');
  assert.equal(plainText('Version #2 costs $5 * 3.'), 'Version #2 costs $5 * 3.');
  assert.equal(plainText('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(plainText('1. First choice\n2. Second choice'), 'First choice\nSecond choice');
});

test('both protocols clean visible text while keeping raw and tool data', async () => {
  const openai = await requestTurn({
    config: goOpenAI,
    apiKey: 'k',
    sessionId: 's',
    system: 'x',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => json({
      choices: [{ message: { content: '## Summary\n- **Done**' } }],
      usage: { opencode: { billing_source: 'go' } },
    }),
  });
  assert.equal(openai.text, 'Summary\nDone');

  const anthropic = await requestTurn({
    config: goAnthropic,
    apiKey: 'k',
    sessionId: 's',
    system: 'x',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => json({
      content: [{ type: 'text', text: '- **Done**' }],
      stop_reason: 'end_turn',
      usage: { opencode: { billing_source: 'go' } },
    }),
  });
  assert.equal(anthropic.text, 'Done');
  assert.equal(anthropic.raw.content[0].text, '- **Done**');

  const withTool = await requestTurn({
    config: goOpenAI,
    apiKey: 'k',
    sessionId: 's',
    system: 'x',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => json({
      choices: [{
        message: {
          content: '`clicked`',
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'observe_page', arguments: '{"cursor":"2"}' } }],
        },
      }],
      usage: { opencode: { billing_source: 'go' } },
    }),
  });
  assert.equal(withTool.text, 'clicked');
  assert.equal(withTool.toolCalls[0].args.cursor, '2');
});

test('an image rejection is distinguishable from a generic bad request', async () => {
  const config = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  await assert.rejects(
    requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }] }],
      fetchImpl: async () => json({ error: 'image input is not available on this engine' }, 400),
    }),
    (error) => error.code === 'image_rejected',
  );
  await assert.rejects(
    requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ error: 'bad request' }, 400),
    }),
    (error) => error.code === 'bad_request',
  );
});

test('HTTP, argument, empty and timeout failures map to stable codes', async () => {
  const config = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  await assert.rejects(
    requestTurn({ config, apiKey: 'k', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => json({ error: 'no' }, 401) }),
    (error) => error.code === 'auth',
  );
  await assert.rejects(
    requestTurn({
      config, apiKey: 'k', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'observe_page', arguments: '{oops' } }] } }] }),
    }),
    (error) => error.code === 'bad_arguments',
  );
  await assert.rejects(
    requestTurn({ config, apiKey: 'k', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => json({ choices: [{ message: { content: '' } }] }) }),
    (error) => error.code === 'empty',
  );
  await assert.rejects(
    requestTurn({
      config, apiKey: 'k', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }], timeoutMs: 25,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
      }),
    }),
    (error) => error.code === 'timeout',
  );
  await assert.rejects(
    requestTurn({ config, apiKey: 'k', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { throw new TypeError('offline'); } }),
    (error) => error.code === 'network',
  );
  await assert.rejects(
    requestTurn({ config, apiKey: '', sessionId: 's', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => json({}) }),
    (error) => error.code === 'no_key',
  );
});

test('regression: HTTP error bodies never reach error messages', async () => {
  const config = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  const secret = 'sk-reflected-secret-123';
  const attempt = (status, body) => requestTurn({
    config,
    apiKey: 'k',
    sessionId: 's',
    system: 'x',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => json(body, status),
  });
  for (const [status, code] of [[401, 'auth'], [400, 'bad_request'], [500, 'http']]) {
    await assert.rejects(
      attempt(status, { error: { message: `Invalid key ${secret}`, api_key: secret } }),
      (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, new RegExp(`HTTP ${status}`, 'u'));
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
  await assert.rejects(
    attempt(400, { error: `image input refused for key ${secret}` }),
    (error) => {
      assert.equal(error.code, 'image_rejected');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  await assert.rejects(
    requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => { throw new TypeError(`fetch failed for key ${secret}`); },
    }),
    (error) => {
      assert.equal(error.code, 'network');
      assert.equal(error.message, 'Could not reach the model service');
      return true;
    },
  );
});

test('regression: malformed tool call lists are invalid responses', async () => {
  const config = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  for (const toolCalls of [{ name: 'observe_page' }, 'observe_page', 42]) {
    await assert.rejects(
      requestTurn({
        config,
        apiKey: 'k',
        sessionId: 's',
        system: 'x',
        messages: [{ role: 'user', content: 'x' }],
        fetchImpl: async () => json({ choices: [{ message: { content: 'hi', tool_calls: toolCalls } }] }),
      }),
      (error) => error.code === 'invalid_response' && /invalid tool call list/u.test(error.message),
    );
  }
  for (const message of [{ content: 'hi' }, { content: 'hi', tool_calls: null }]) {
    const result = await requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ choices: [{ message }] }),
    });
    assert.equal(result.text, 'hi');
    assert.deepEqual(result.toolCalls, []);
  }
});

test('regression: a refusal response is denied before tool parsing', async () => {
  const config = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  const choices = [
    { message: { content: null, refusal: 'I cannot help with that.' } },
    { message: { content: null, refusal: 'I cannot help with that.', tool_calls: { malformed: true } } },
    { message: { content: null }, finish_reason: 'content_filter' },
    { message: { content: null, tool_calls: 'malformed' }, finish_reason: 'content_filter' },
    { message: { content: 'Refused text' }, finish_reason: 'content_filter' },
  ];
  for (const choice of choices) {
    await assert.rejects(
      requestTurn({
        config,
        apiKey: 'k',
        sessionId: 's',
        system: 'x',
        messages: [{ role: 'user', content: 'x' }],
        fetchImpl: async () => json({ choices: [choice] }),
      }),
      (error) => error.code === 'denied',
    );
  }
  await assert.rejects(
    requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => json({ choices: [{ message: { content: '', refusal: '' } }] }),
    }),
    (error) => error.code === 'empty',
  );
});
