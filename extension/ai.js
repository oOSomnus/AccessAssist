// Two wire formats, one neutral message history. Every provider-specific
// detail stays in this file; the side panel only sees requestTurn results.
import { TOOLS } from './protocol.js';

export class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  protocol: 'openai',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  model: 'deepseek-v4.1-flash',
  anthropicVersion: '2026-10-21',
  effort: 'default',
});

const EFFORT_LEVELS = new Set(['default', 'low', 'medium', 'high', 'max']);
const EFFORT_ERROR = 'Effort must be default, low, medium, high, or max';
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ENDPOINT_SUFFIX = /(?:\/chat\/completions|\/messages)\/?$/u;

function cleanBaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Missing API URL' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'API URL is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'API URL must use HTTPS' };
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return { error: 'HTTP is only allowed for localhost; other addresses must use HTTPS' };
  }
  if (url.username || url.password) return { error: 'API URL must not include a username or password' };
  if (url.search || url.hash) return { error: 'API URL must not include a query or fragment' };
  if (ENDPOINT_SUFFIX.test(url.pathname)) return { error: 'API URL must stop at the version path; do not include chat/completions or messages' };
  const path = url.pathname.replace(/\/+$/u, '');
  return { baseUrl: `${url.origin}${path}` };
}

export function normalizeConfig(raw = {}) {
  const errors = [];
  const protocol = raw.protocol === 'anthropic' ? 'anthropic' : raw.protocol === 'openai' ? 'openai' : null;
  if (!protocol) errors.push('Protocol must be openai or anthropic');
  const { baseUrl, error: urlError } = cleanBaseUrl(raw.baseUrl);
  if (urlError) errors.push(urlError);
  const model = String(raw.model ?? '').trim();
  if (!model) errors.push('Missing model name');
  else if (model.length > 200 || /[\u0000-\u001f]/u.test(model)) errors.push('Invalid model name');
  let anthropicVersion = String(raw.anthropicVersion ?? DEFAULT_CONFIG.anthropicVersion).trim();
  if (protocol === 'anthropic') {
    if (!anthropicVersion) errors.push('Missing Anthropic API version');
    else if (!VERSION_PATTERN.test(anthropicVersion)) errors.push('Anthropic API version must be YYYY-MM-DD');
  }
  let effort = 'default';
  if (typeof raw.effort === 'string') effort = raw.effort.trim().toLowerCase() || 'default';
  else if (raw.effort != null) effort = '';
  if (!EFFORT_LEVELS.has(effort)) errors.push(EFFORT_ERROR);
  if (errors.length) return { errors };
  return {
    errors: [],
    config: {
      protocol,
      baseUrl,
      model,
      effort,
      ...(protocol === 'anthropic' ? { anthropicVersion } : {}),
    },
  };
}

export function endpointFor(config) {
  return `${config.baseUrl}${config.protocol === 'anthropic' ? '/messages' : '/chat/completions'}`;
}

export function isGoConfig(config) {
  try {
    const url = new URL(config.baseUrl);
    return url.origin === 'https://opencode.ai' && url.pathname.startsWith('/inference/go/');
  } catch {
    return false;
  }
}

export function buildHeaders(config, apiKey, sessionId) {
  if (!apiKey) throw new ApiError('no_key', 'No API key set');
  const headers = { 'content-type': 'application/json' };
  if (config.protocol === 'anthropic') {
    if (isGoConfig(config)) headers.authorization = `Bearer ${apiKey}`;
    else {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = config.anthropicVersion;
      if (new URL(config.baseUrl).hostname === 'api.anthropic.com') {
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }
    }
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (isGoConfig(config) && sessionId) headers['x-opencode-session'] = sessionId;
  return headers;
}

function openaiContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  const images = parts.filter((part) => part.type === 'image');
  if (images.length === 0) return parts.map((part) => part.text ?? '').join('\n');
  return [
    ...parts.filter((part) => part.type === 'text' && part.text).map((part) => ({ type: 'text', text: part.text })),
    ...images.map((part) => ({
      type: 'image_url',
      image_url: { url: `data:${part.mediaType ?? 'image/png'};base64,${part.data}` },
    })),
  ];
}

function anthropicContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  const blocks = [];
  for (const part of parts) {
    if (part.type === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType ?? 'image/png', data: part.data },
      });
    } else if (part.text) {
      blocks.push({ type: 'text', text: part.text });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: ' ' }];
}

function openaiMessages(system, messages) {
  const output = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: openaiContent(message.content) });
    } else if (message.role === 'assistant') {
      const entry = { role: 'assistant', content: message.text ?? '' };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      if (message.raw?.reasoning_content) entry.reasoning_content = message.raw.reasoning_content;
      output.push(entry);
    } else if (message.role === 'tool') {
      for (const result of message.results ?? []) {
        // OpenAI tool messages have no error flag, so the text must carry it.
        const content = String(result.content ?? '');
        output.push({ role: 'tool', tool_call_id: result.id, content: result.isError ? `Error: ${content}` : content });
      }
    }
  }
  return output;
}

function anthropicMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: anthropicContent(message.content) });
    } else if (message.role === 'assistant') {
      const content = message.raw?.provider === 'anthropic' && Array.isArray(message.raw.content)
        ? message.raw.content
        : [
          ...(message.text ? [{ type: 'text', text: message.text }] : []),
          ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })),
        ];
      if (content.length) output.push({ role: 'assistant', content });
    } else if (message.role === 'tool' && message.results?.length) {
      output.push({
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: String(result.content ?? ''),
          ...(result.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return output;
}

// No output cap of our own. Reasoning counts against the output limit, so a
// fixed cap cuts off a reply that is still thinking (finish_reason "length"
// with nothing said). OpenAI-compatible requests leave max_tokens out, so the
// provider's own maximum applies. Anthropic requires the field, so it gets
// the largest output current Claude models allow; an older model that allows
// less names its cap in the 400, and requestTurn retries once with it.
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 128_000;

export function buildBody(config, { system, messages, tools = TOOLS, maxTokens = null }) {
  if (config.protocol === 'anthropic') {
    return {
      model: config.model,
      max_tokens: maxTokens ?? ANTHROPIC_MAX_OUTPUT_TOKENS,
      system,
      messages: anthropicMessages(messages),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      stream: false,
      ...(config.effort && config.effort !== 'default' ? { output_config: { effort: config.effort } } : {}),
    };
  }
  return {
    model: config.model,
    messages: openaiMessages(system, messages),
    tools: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: false,
    ...(config.effort && config.effort !== 'default' ? { reasoning_effort: config.effort } : {}),
  };
}

function usageBilling(usage) {
  return usage?.opencode?.billing_source ?? null;
}

function checkBilling(config, usage) {
  if (!isGoConfig(config)) return;
  const source = usageBilling(usage);
  if (source !== 'go' && source !== 'go-plus') {
    throw new ApiError('billing', 'OpenCode Go is not billed as Go; requests stopped');
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === 'text' || part.type === 'output_text'))
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

// Removes explicit Markdown structure at the neutral visible-text boundary.
// It never strips ordinary characters globally, so amounts, negative numbers,
// identifiers, and URLs survive.
export function plainText(value) {
  let text = String(value ?? '');
  if (!text) return '';
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gmu, '');
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gmu, '');
  text = text.replace(/^[ \t]*[-*+•‣][ \t]+/gmu, '');
  text = text.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gmu, '');
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*\r?\n/gmu, '');
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gmu, (_, row) => row
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' '));
  const kept = [];
  const keep = (value) => `\u0000${kept.push(value) - 1}\u0000`;
  text = text.replace(/`([^`\n]+)`/gu, (_, code) => keep(code));
  text = text.replace(/https?:\/\/[^\s<>()\[\]]+/gu, keep);
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '$1');
  text = text.replace(/__([^_\n]+)__/gu, '$1');
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/gu, '$1$2');
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/gu, '$1$2');
  text = text.replace(/\u0000(\d+)\u0000/gu, (_, index) => kept[Number(index)]);
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/gu, '$1');
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/gu, (_, label, href) => (
    href && label !== href ? `${label} (${href})` : label
  ));
  text = text.replace(/<((?:https?:\/\/)[^>\s]+)>/gu, '$1');
  return text.replace(/\n{3,}/gu, '\n\n').trim();
}

function parseOpenAI(config, json) {
  const choice = json?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new ApiError('invalid_response', 'Model response is missing a message');
  const refusal = typeof message.refusal === 'string' ? message.refusal : '';
  if (refusal || choice.finish_reason === 'content_filter') throw new ApiError('denied', 'Model refused this request');
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) {
    throw new ApiError('invalid_response', 'Model returned an invalid tool call list');
  }
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    if (call?.type !== 'function' || !call.function?.name) {
      throw new ApiError('invalid_response', 'Model returned an unrecognized tool call');
    }
    let args = {};
    const rawArgs = call.function.arguments;
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        throw new ApiError('bad_arguments', `Arguments for tool ${call.function.name} are not valid JSON`);
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new ApiError('bad_arguments', `Arguments for tool ${call.function.name} must be an object`);
    }
    return { id: call.id || `call_${globalThis.crypto.randomUUID()}`, name: call.function.name, args };
  });
  if (choice.finish_reason === 'length') throw new ApiError('truncated', 'Model reply was truncated; try again');
  const text = plainText(textFromContent(message.content));
  if (!text && toolCalls.length === 0) throw new ApiError('empty', 'Model returned no content');
  checkBilling(config, json?.usage);
  return {
    text,
    toolCalls,
    raw: { provider: 'openai', ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) },
    usage: json?.usage ?? null,
    stopReason: choice.finish_reason ?? null,
  };
}

function parseAnthropic(config, json) {
  const blocks = Array.isArray(json?.content) ? json.content : null;
  if (!blocks) throw new ApiError('invalid_response', 'Model response is missing content');
  const text = plainText(blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n').trim());
  const toolCalls = blocks.filter((block) => block?.type === 'tool_use').map((block) => {
    if (!block.id || !block.name) throw new ApiError('invalid_response', 'Anthropic tool call is missing an id or name');
    const input = block.input ?? {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new ApiError('bad_arguments', `Arguments for tool ${block.name} must be an object`);
    }
    return { id: block.id, name: block.name, args: input };
  });
  const stopReason = json?.stop_reason ?? null;
  if (stopReason === 'max_tokens') throw new ApiError('truncated', 'Model reply was truncated; try again');
  if (stopReason === 'refusal') throw new ApiError('denied', 'Model refused this request');
  if (!text && toolCalls.length === 0) throw new ApiError('empty', 'Model returned no content');
  checkBilling(config, json?.usage);
  return {
    text,
    toolCalls,
    raw: { provider: 'anthropic', content: blocks },
    usage: json?.usage ?? null,
    stopReason,
  };
}

export function mapHttpError(status, body) {
  // The body is inspected only to classify image rejections; it never goes into
  // a user-visible message because providers may echo credentials. It travels
  // only in details, which the panel scrubs before writing the debug log.
  const detail = String(body ?? '');
  const details = { status, body: detail.slice(0, 2000) };
  if (status === 401 || status === 403) return new ApiError('auth', `Model service rejected authentication (HTTP ${status})`, details);
  if (status === 429) return new ApiError('rate_limit', 'Too many requests to the model service (HTTP 429); try again later', details);
  if ((status === 400 || status === 422) && /image|vision|multimodal/iu.test(detail)) {
    return new ApiError('image_rejected', `Model service rejected the screenshot (HTTP ${status})`, details);
  }
  if (status === 400 || status === 422) return new ApiError('bad_request', `Model service rejected the request (HTTP ${status})`, details);
  return new ApiError('http', `Model service returned an error (HTTP ${status})`, details);
}

export const REQUEST_TIMEOUT_MS = 180_000;

// Output caps Anthropic reported for models that allow less than
// ANTHROPIC_MAX_OUTPUT_TOKENS, by endpoint and model, for this session.
const anthropicOutputCaps = new Map();

// "max_tokens: 128000 > 64000, which is the maximum allowed number of output
// tokens for ..." -> 64000. Null when the 400 is about something else.
export function reportedOutputCap(body) {
  const match = /max_tokens\D{0,20}\d+\s*>\s*(\d+)/u.exec(String(body ?? ''));
  const cap = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

export async function requestTurn({
  config,
  apiKey,
  sessionId,
  system,
  messages,
  tools = TOOLS,
  signal,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxTokens = null,
}) {
  const normalized = normalizeConfig(config);
  if (normalized.errors.length) throw new ApiError('config', normalized.errors.join('; '));
  const settings = normalized.config;
  if (!apiKey) throw new ApiError('no_key', 'No API key set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  const capKey = `${settings.baseUrl} ${settings.model}`;
  const send = (tokens) => fetchImpl(endpointFor(settings), {
    method: 'POST',
    headers: buildHeaders(settings, apiKey, sessionId),
    body: JSON.stringify(buildBody(settings, { system, messages, tools, maxTokens: tokens })),
    signal: controller.signal,
  });
  try {
    let tokens = maxTokens;
    if (tokens == null && settings.protocol === 'anthropic') {
      tokens = anthropicOutputCaps.get(capKey) ?? ANTHROPIC_MAX_OUTPUT_TOKENS;
    }
    let response = await send(tokens);
    let bodyText = await response.text();
    if (response.status === 400 && maxTokens == null && settings.protocol === 'anthropic') {
      const cap = reportedOutputCap(bodyText);
      if (cap && cap < tokens) {
        anthropicOutputCaps.set(capKey, cap);
        response = await send(cap);
        bodyText = await response.text();
      }
    }
    if (!response.ok) throw mapHttpError(response.status, bodyText);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new ApiError('invalid_json', 'Model service returned invalid JSON', { body: bodyText.slice(0, 2000) });
    }
    try {
      return settings.protocol === 'anthropic' ? parseAnthropic(settings, json) : parseOpenAI(settings, json);
    } catch (error) {
      // Empty, truncated and billing failures carry the raw reply for the debug log.
      error.details ??= { body: bodyText.slice(0, 2000) };
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new ApiError('timeout', 'Model request timed out; try again', {
        elapsedMs: Date.now() - started,
        timeoutMs,
        cancelled: signal?.aborted === true,
      });
    }
    throw new ApiError('network', 'Could not reach the model service', { cause: String(error?.message ?? error) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
