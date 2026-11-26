import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_MAX_OUTPUT_TOKENS,
  DEFAULT_CONFIG,
  buildHeaders,
  endpointFor,
  isGoConfig,
  listChatgptModels,
  normalizeConfig,
  plainText,
  reportedOutputCap,
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

test('effort is normalized and only explicit levels reach each wire format', async () => {
  assert.equal(normalizeConfig(goOpenAI).config.effort, 'default');
  assert.equal(normalizeConfig(goAnthropic).config.effort, 'default');
  assert.equal(normalizeConfig({ ...goOpenAI, effort: ' HIGH ' }).config.effort, 'high');
  assert.equal(normalizeConfig({ ...goOpenAI, effort: undefined }).config.effort, 'default');
  assert.equal(normalizeConfig({ ...goOpenAI, effort: '' }).config.effort, 'default');
  for (const effort of ['xhigh', 1, true]) {
    assert.match(normalizeConfig({ ...goOpenAI, effort }).errors[0], /^Effort must be default, low, medium, high, or max$/u);
  }

  const openaiBase = { ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' };
  const anthropicBase = { ...goAnthropic, baseUrl: 'https://example.test/anthropic/v1' };
  const bodies = [];
  const send = async (config) => {
    await requestTurn({
      config,
      apiKey: 'k',
      sessionId: 's',
      system: 'sys',
      maxTokens: 777,
      messages: [
        { role: 'user', content: 'read' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'observe_page', args: {} }], raw: { reasoning_content: 'Think' } },
        { role: 'tool', results: [{ id: 'call_1', content: 'result', isError: false }] },
      ],
      fetchImpl: async (url, init) => {
        bodies.push({ url, body: JSON.parse(init.body), headers: init.headers });
        return json(config.protocol === 'anthropic'
          ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { opencode: { billing_source: 'go' } } }
          : { choices: [{ message: { content: 'ok' } }] });
      },
    });
  };

  await send({ ...openaiBase, effort: 'default' });
  await send({ ...openaiBase, effort: 'high' });
  await send({ ...anthropicBase, effort: 'default' });
  await send({ ...anthropicBase, effort: 'max' });

  assert.equal('reasoning_effort' in bodies[0].body, false);
  assert.equal('output_config' in bodies[0].body, false);
  assert.equal(bodies[1].body.reasoning_effort, 'high');
  assert.equal('output_config' in bodies[1].body, false);
  assert.equal('reasoning_effort' in bodies[2].body, false);
  assert.equal('output_config' in bodies[2].body, false);
  assert.deepEqual(bodies[3].body.output_config, { effort: 'max' });
  assert.equal('reasoning_effort' in bodies[3].body, false);
  assert.equal(bodies[1].body.max_tokens, 777);
  assert.equal(bodies[1].body.messages[2].reasoning_content, 'Think');
  assert.equal(bodies[1].body.messages[3].tool_call_id, 'call_1');
  assert.equal(bodies[1].headers.authorization, 'Bearer k');

  let fetches = 0;
  await assert.rejects(
    requestTurn({
      config: { ...openaiBase, effort: 'nope' },
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => { fetches += 1; return json({}); },
    }),
    (error) => error.code === 'config' && /^Effort must be/u.test(error.message),
  );
  assert.equal(fetches, 0);

  let attempts = 0;
  await assert.rejects(
    requestTurn({
      config: { ...openaiBase, effort: 'high' },
      apiKey: 'k',
      sessionId: 's',
      system: 'x',
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async (url, init) => {
        attempts += 1;
        assert.equal(JSON.parse(init.body).reasoning_effort, 'high');
        return json({ error: 'unsupported effort' }, 400);
      },
    }),
    (error) => error.code === 'bad_request',
  );
  assert.equal(attempts, 1);
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
  assert.equal(plainText('Use `__init__`.'), 'Use __init__.');
  assert.equal(plainText('See https://example.test/_private_/guide now'), 'See https://example.test/_private_/guide now');
  assert.equal(plainText('[https://example.test/a_b_c](https://example.test/a_b_c)'), 'https://example.test/a_b_c');
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
        assert.equal(error.details.status, status);
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

test('no output cap of our own: OpenAI omits max_tokens, Anthropic sends the model maximum', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return json(url.endsWith('/messages')
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { opencode: { billing_source: 'go' } } }
      : { choices: [{ message: { content: 'ok' } }], usage: { opencode: { billing_source: 'go' } } });
  };
  const base = { apiKey: 'k', sessionId: 's', system: 'sys', messages: [{ role: 'user', content: 'hi' }], fetchImpl };
  await requestTurn({ ...base, config: { ...goOpenAI, effort: 'max' } });
  await requestTurn({ ...base, config: goAnthropic });
  assert.equal('max_tokens' in sent[0], false);
  assert.equal(sent[0].reasoning_effort, 'max');
  assert.equal(sent[1].max_tokens, ANTHROPIC_MAX_OUTPUT_TOKENS);
  assert.equal(ANTHROPIC_MAX_OUTPUT_TOKENS, 128_000);
});

test('an Anthropic model with a smaller output cap is retried once at its reported cap', async () => {
  const config = { ...goAnthropic, baseUrl: 'https://example.test/anthropic/v1', model: 'older-model' };
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.max_tokens);
    if (body.max_tokens > 64000) {
      return json({
        type: 'error',
        error: { type: 'invalid_request_error', message: `max_tokens: ${body.max_tokens} > 64000, which is the maximum allowed number of output tokens for older-model` },
      }, 400);
    }
    return json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  };
  const base = { config, apiKey: 'k', sessionId: 's', system: 'sys', messages: [{ role: 'user', content: 'hi' }], fetchImpl };
  assert.equal((await requestTurn(base)).text, 'ok');
  assert.deepEqual(sent, [128_000, 64_000]);
  // The reported cap is remembered: the next request goes straight to it.
  assert.equal((await requestTurn(base)).text, 'ok');
  assert.deepEqual(sent, [128_000, 64_000, 64_000]);

  // An unrelated 400 is not retried.
  let attempts = 0;
  await assert.rejects(
    requestTurn({
      ...base,
      config: { ...config, model: 'other-model' },
      fetchImpl: async () => {
        attempts += 1;
        return json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: bad role' } }, 400);
      },
    }),
    (error) => error.code === 'bad_request',
  );
  assert.equal(attempts, 1);
});

test('reportedOutputCap reads only an output-cap complaint', () => {
  assert.equal(reportedOutputCap('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for x'), 64000);
  assert.equal(reportedOutputCap('{"message":"max_tokens: 128000 > 32000, which is the maximum"}'), 32000);
  assert.equal(reportedOutputCap('messages: bad role'), null);
  assert.equal(reportedOutputCap(undefined), null);
});

const chatgptConfig = { protocol: 'chatgpt', model: 'gpt-test', effort: 'default' };
const sse = (...events) => new Response(
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const completed = (output, extra = {}) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { total_tokens: 5 }, ...extra } });

test('chatgpt config is pinned to OpenAI and takes its own effort levels', () => {
  const normalized = normalizeConfig({ ...chatgptConfig, baseUrl: 'https://evil.example/v1', effort: 'XHIGH' });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.config, { protocol: 'chatgpt', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', effort: 'xhigh' });
  assert.match(normalizeConfig({ ...chatgptConfig, effort: 'max' }).errors[0], /^Effort must be default, low, medium, high, or xhigh$/u);
  assert.deepEqual(normalizeConfig({ ...chatgptConfig, model: '' }).errors, ['Missing model name']);
  assert.equal(endpointFor(normalized.config), 'https://api.openai.com/v1/responses');
  assert.deepEqual(buildHeaders(normalized.config, 'tok', 'session'), {
    'content-type': 'application/json',
    authorization: 'Bearer tok',
    accept: 'text/event-stream',
  });
});

test('chatgpt body is a Responses request with replayed items and no output cap', async () => {
  const sent = [];
  const send = (config) => requestTurn({
    config,
    apiKey: 'tok',
    sessionId: 's',
    system: 'Be brief',
    maxTokens: 999,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'observe_page', args: {} }],
        raw: {
          provider: 'chatgpt',
          output: [
            { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc', summary: [] },
            { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'observe_page', arguments: '{}' },
          ],
        },
      },
      { role: 'tool', results: [{ id: 'call_1', content: 'boom', isError: true }] },
      { role: 'assistant', text: 'From another service', toolCalls: [], raw: { provider: 'openai' } },
    ],
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return sse(completed([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]));
    },
  });
  await send(chatgptConfig);
  await send({ ...chatgptConfig, effort: 'low' });
  const [plain, low] = sent;
  assert.equal(plain.url, 'https://api.openai.com/v1/responses');
  assert.equal(plain.body.store, false);
  assert.equal(plain.body.stream, true);
  assert.equal(plain.body.instructions, 'Be brief');
  assert.equal('max_output_tokens' in plain.body, false);
  assert.equal('max_tokens' in plain.body, false);
  assert.equal('reasoning' in plain.body, false);
  assert.deepEqual(low.body.reasoning, { effort: 'low' });
  assert.deepEqual(plain.body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(plain.body.tools[0], {
    type: 'function',
    name: plain.body.tools[0].name,
    description: plain.body.tools[0].description,
    parameters: plain.body.tools[0].parameters,
  });
  assert.deepEqual(plain.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'reasoning', encrypted_content: 'enc', summary: [] },
    { type: 'function_call', call_id: 'call_1', name: 'observe_page', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Error: boom' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'From another service' }] },
  ]);
});

test('chatgpt stream results are parsed only from the terminal event', async () => {
  const turn = (response) => requestTurn({
    config: chatgptConfig, apiKey: 'tok', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => response,
  });
  const output = [
    { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc' },
    { type: 'message', content: [{ type: 'output_text', text: '**Two** buttons' }] },
    { type: 'function_call', call_id: 'call_9', name: 'observe_page', arguments: '{"cursor":"c"}' },
  ];
  const result = await turn(sse(
    { type: 'response.created', response: { status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', delta: 'Two' },
    completed(output),
  ));
  assert.equal(result.text, 'Two buttons');
  assert.deepEqual(result.toolCalls, [{ id: 'call_9', name: 'observe_page', args: { cursor: 'c' } }]);
  assert.deepEqual(result.raw, { provider: 'chatgpt', output });
  assert.equal(result.stopReason, 'completed');

  await assert.rejects(turn(sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } })), (error) => error.code === 'truncated');
  await assert.rejects(turn(sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } })), (error) => error.code === 'denied');
  await assert.rejects(turn(sse(completed([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]))), (error) => error.code === 'denied');
  await assert.rejects(turn(sse({ type: 'response.output_text.delta', delta: 'half' })), (error) => error.code === 'interrupted');
  await assert.rejects(
    turn(sse({ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit for sk-secret' } } })),
    (error) => error.code === 'plan_limit' && !error.message.includes('sk-secret'),
  );
  await assert.rejects(turn(sse({ type: 'error', code: 'server_error', message: 'x' })), (error) => error.code === 'http');
  await assert.rejects(turn(sse(completed([{ type: 'function_call', call_id: 'c', name: 'observe_page', arguments: '{bad' }]))), (error) => error.code === 'bad_arguments');
});

test('plan errors map to stable codes without echoing the body', async () => {
  const secret = 'sk-reflected-secret-456';
  const attempt = (status, body) => requestTurn({
    config: chatgptConfig, apiKey: 'tok', system: 'x', messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => json(body, status),
  });
  for (const [status, code, expected] of [
    [429, 'subscription_sharing_usage_limit_exceeded', 'plan_limit'],
    [403, 'subscription_sharing_user_not_eligible', 'plan_ineligible'],
    [503, 'subscription_sharing_usage_unavailable', 'plan_unavailable'],
    [401, 'subscription_sharing_invalid_user', 'signed_out'],
  ]) {
    await assert.rejects(attempt(status, { error: { code, message: `nope ${secret}` } }), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.details.status, status);
      return true;
    });
  }
  await assert.rejects(
    attempt(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'reasoning.effort' } }),
    (error) => error.code === 'unsupported' && error.details.param === 'reasoning.effort',
  );
  await assert.rejects(
    attempt(400, { error: { code: 'subscription_sharing_unsupported_capability', param: `x ${secret}` } }),
    (error) => error.code === 'unsupported' && !error.message.includes(secret) && !('param' in error.details),
  );
  // Admission failures can carry {"detail": ...}; they map by status.
  await assert.rejects(attempt(401, { detail: `bad ${secret}` }), (error) => error.code === 'auth' && !error.message.includes(secret));
});

test('ChatGPT models come from the account listing', async () => {
  let request;
  const models = await listChatgptModels({
    accessToken: 'tok',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return json({ models: [
        { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' },
        { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-b' },
        { slug: 'gpt-a', display_name: 'Duplicate' },
      ] });
    },
  });
  assert.equal(request.url, 'https://api.openai.com/v1/models');
  assert.equal(request.init.headers.authorization, 'Bearer tok');
  assert.deepEqual(models, [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b', name: 'gpt-b' }]);
  assert.deepEqual(
    await listChatgptModels({ accessToken: 'tok', fetchImpl: async () => json({ data: [{ id: 'gpt-c' }] }) }),
    [{ id: 'gpt-c', name: 'gpt-c' }],
  );
  await assert.rejects(listChatgptModels({ accessToken: 'tok', fetchImpl: async () => json({}, 401) }), (error) => error.code === 'auth');
  await assert.rejects(listChatgptModels({ accessToken: '' }), (error) => error.code === 'signed_out');
});
