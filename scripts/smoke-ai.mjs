// Live Go check: fixed model, both wire formats, one tool turn and one real
// image turn. Never prints the key or the generated code.
import zlib from 'node:zlib';
import { DEFAULT_CONFIG, normalizeConfig, requestTurn } from '../extension/ai.js';
import { checkError, isMain, protocolSelectionError, selectProtocols } from './live-check.mjs';

const MODEL = 'deepseek-v4.1-flash';

const CONFIGS = [
  { name: 'openai', config: { ...DEFAULT_CONFIG, model: MODEL } },
  {
    name: 'anthropic',
    config: {
      protocol: 'anthropic',
      baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
      model: MODEL,
      anthropicVersion: '2026-10-21',
    },
  },
];

const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function codeImage(code) {
  const scale = 18;
  const margin = 20;
  const gap = 12;
  const width = margin * 2 + code.length * 3 * scale + (code.length - 1) * gap;
  const height = margin * 2 + 5 * scale;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) pixels.fill(255, index * 4, index * 4 + 4);
  [...code].forEach((digit, position) => {
    const rows = FONT[digit];
    const originX = margin + position * (3 * scale + gap);
    rows.forEach((row, rowIndex) => {
      [...row].forEach((cell, columnIndex) => {
        if (cell !== '1') return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = originX + columnIndex * scale + dx;
            const y = margin + rowIndex * scale + dy;
            const offset = (y * width + x) * 4;
            pixels[offset] = 0;
            pixels[offset + 1] = 0;
            pixels[offset + 2] = 0;
            pixels[offset + 3] = 255;
          }
        }
      });
    });
  });
  return encodePng(width, height, pixels);
}

function controlImage() {
  const width = 640;
  const height = 360;
  const target = {
    x: 120 + Math.floor(Math.random() * 300),
    y: 90 + Math.floor(Math.random() * 150),
    width: 90,
    height: 60,
  };
  const distractor = { x: 380, y: 60, width: 120, height: 90 };
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 255;
    pixels[index * 4 + 1] = 255;
    pixels[index * 4 + 2] = 255;
    pixels[index * 4 + 3] = 255;
  }
  const paint = (rect, color) => {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  };
  paint(distractor, [0, 51, 204]);
  paint(target, [212, 0, 0]);
  return { png: encodePng(width, height, pixels), width, height, target };
}

const GROUNDING_TOOLS = [{
  name: 'click_control',
  description: 'Click the red control in the image with CSS pixel coordinates.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Horizontal CSS pixel coordinate' },
      y: { type: 'number', description: 'Vertical CSS pixel coordinate' },
    },
    required: ['x', 'y'],
    additionalProperties: false,
  },
}];

export function insideTarget(point, rect) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    && point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function redact(result) {
  const usage = result.usage ?? {};
  return {
    stopReason: result.stopReason,
    textLength: result.text.length,
    toolCalls: result.toolCalls.map((call) => call.name),
    billing: usage.opencode?.billing_source ?? null,
    tokens: usage.total_tokens ?? null,
  };
}

async function checkFormat({ name, config, key }) {
  const normalized = normalizeConfig(config);
  if (normalized.errors.length) throw checkError('INVALID_CONFIG');
  const settings = normalized.config;
  const summary = { format: name, endpoint: settings.baseUrl, model: settings.model };

  const toolTurn = await requestTurn({
    config: settings,
    apiKey: key,
    sessionId: `smoke-${name}`,
    system: 'You must call the provided tool to complete the task; do not answer with text only.',
    messages: [{ role: 'user', content: 'Call the observe_page tool and do nothing else.' }],
  });
  summary.tool = redact(toolTurn);
  if (!toolTurn.toolCalls.some((call) => call.name === 'observe_page')) {
    throw checkError('TOOL_CALL_MISSING');
  }

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const png = codeImage(code);
  const vision = await requestTurn({
    config: settings,
    apiKey: key,
    sessionId: `smoke-${name}-vision`,
    system: 'You are an OCR system. Answer only with the digits in the image; do not explain.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: png.toString('base64') },
        { type: 'text', text: 'Read the four digits in the image and answer with only those four digits.' },
      ],
    }],
    tools: [],
  });
  summary.vision = redact(vision);
  const digits = (vision.text.match(/\d/g) ?? []).join('');
  summary.vision.correct = digits.includes(code);
  if (!digits.includes(code)) throw checkError('IMAGE_READBACK_FAILED');

  const control = controlImage();
  const grounding = await requestTurn({
    config: settings,
    apiKey: key,
    sessionId: `smoke-${name}-grounding`,
    system: 'Use the click_control tool. Do not answer with text only.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: control.png.toString('base64') },
        { type: 'text', text: 'Click the red control. Coordinates are CSS pixels in this image.' },
      ],
    }],
    tools: GROUNDING_TOOLS,
  });
  const call = grounding.toolCalls.find((candidate) => candidate.name === 'click_control');
  const point = call?.args ?? null;
  summary.grounding = {
    ...redact(grounding),
    point,
    correct: insideTarget(point, control.target),
  };
  if (!summary.grounding.correct) {
    throw checkError('GROUNDING_FAILED');
  }
  return summary;
}

export async function main() {
  const selected = selectProtocols(CONFIGS);
  if (!selected) {
    console.error(protocolSelectionError());
    process.exitCode = 2;
    return;
  }
  const key = process.env.OPENCODE_ACCESS_KEY;
  if (!key) {
    console.error('Missing OPENCODE_ACCESS_KEY');
    process.exitCode = 2;
    return;
  }
  const results = [];
  let failed = false;
  for (const entry of selected) {
    try {
      results.push(await checkFormat({ ...entry, key }));
      console.log(`Passed ${entry.name}`);
    } catch (error) {
      failed = true;
      const message = error?.code === 'AA_CHECK' ? error.message : 'LIVE_CHECK_FAILED';
      results.push({ format: entry.name, error: message });
      console.error(`Failed ${entry.name}: ${message}`);
    }
  }
  console.log(JSON.stringify({ model: MODEL, results }, null, 2));
  if (failed) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
