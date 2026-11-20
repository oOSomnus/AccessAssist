// Shared by the AI client, the worker and tests. Tools never accept scripts,
// selectors or CDP commands from the model.
export const MAX_OPTIONS = 9;
export const MAX_LABEL_WORDS = 4;
export const MAX_LABEL_LATIN = 24;
export const STEP_TYPES = Object.freeze([
  'set_value', 'set_checked', 'select_option', 'click', 'hover', 'drag', 'press_key', 'navigate', 'set_alt', 'blur',
]);

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');

export const PRESS_KEYS = Object.freeze([
  'Enter', 'Space', 'Escape', 'Tab', 'Backspace', 'Delete', 'F2', 'F10', 'ContextMenu',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  ...LETTERS, ...DIGITS,
]);

export const PRESS_MODIFIERS = Object.freeze(['Alt', 'Control', 'Meta', 'Shift']);

const schema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const stepSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...STEP_TYPES] },
    id: { type: 'string', description: 'Target id from the latest observation' },
    value: { type: 'string', description: 'set_value: the full new text' },
    checked: { type: 'boolean', description: 'set_checked' },
    values: { type: 'array', items: { type: 'string' }, description: 'select_option: option values' },
    points: {
      type: 'array',
      items: schema({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
      description: 'drag on a screenshot: CSS viewport points, first to last',
    },
    point: {
      ...schema({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
      description: 'click or hover on a screenshot: CSS viewport point',
    },
    key: { type: 'string', enum: [...PRESS_KEYS], description: 'press_key' },
    href: { type: 'string', description: 'navigate: the target link exactly as observed' },
    alt: { type: 'string', description: 'set_alt: image description' },
    toId: { type: 'string', description: 'drag: target id to drop onto' },
    button: { type: 'string', enum: ['left', 'right'], description: 'click only' },
    clickCount: { type: 'integer', enum: [1, 2], description: 'click only' },
    holdMs: { type: 'integer', minimum: 0, maximum: 1500, description: 'click only' },
    durationMs: { type: 'integer', minimum: 0, maximum: 1500, description: 'hover only' },
    modifiers: {
      type: 'array',
      uniqueItems: true,
      maxItems: 4,
      items: { type: 'string', enum: [...PRESS_MODIFIERS] },
      description: 'click, drag or press_key',
    },
    blur: { type: 'boolean', description: 'set_value: false keeps focus' },
  },
  required: ['type', 'id'],
  additionalProperties: false,
};

export const TOOLS = Object.freeze([
  {
    name: 'observe_page',
    description: 'Re-read the visible content, sections and target list of the current page. Targets are visible and on screen unless they say visible false or inViewport false; tag is given only when it differs from role; near holds the text of a label above or left of an unnamed control. A target\'s style names an entry in styles (its colors and class); targets with the same style look alike, which often means the same state. Set visual true only when page structure is not enough: the user must separately allow a screenshot, and the result explains CSS viewport coordinates for a single point action. Observe again after the page changes.',
    parameters: schema({
      cursor: { type: 'string', description: 'Cursor to continue reading' },
      visual: { type: 'boolean', description: 'Request a masked viewport screenshot and visual-region target after separate consent' },
      ask_again: { type: 'boolean', description: 'Only when the user explicitly asked in their newest message to read or look at the page after declining earlier: ask them once more' },
    }),
  },
  {
    name: 'read_target',
    description: 'Read the full text or image information of a target; long text is paged with a cursor.',
    parameters: schema({
      id: { type: 'string' },
      cursor: { type: 'string' },
      ask_again: { type: 'boolean', description: 'Only when the user explicitly asked in their newest message to read or look at the page after declining earlier: ask them once more' },
    }, ['id']),
  },
  {
    name: 'focus_target',
    description: 'Scroll to and focus the target without activating it.',
    parameters: schema({
      id: { type: 'string' },
      ask_again: { type: 'boolean', description: 'Only when the user explicitly asked in their newest message to read or look at the page after declining earlier: ask them once more' },
    }, ['id']),
  },
  {
    name: 'scroll_page',
    description: 'Scroll one screen up, down, left or right. Give a target id to scroll the nearest scrollable list or panel around that target; without it the whole page scrolls. Any scroll, and any focus change, invalidates an earlier screenshot, so observe again before using point coordinates.',
    parameters: schema({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      id: { type: 'string', description: 'Target whose scrollable container should move; omit to scroll the whole page' },
    }, ['direction']),
  },
  {
    name: 'describe_image',
    description: 'Ask about an image. The extension first asks the user to choose AI reading ("Read it") or system screen reader guidance; it takes a screenshot only when the user chooses AI. Choosing "Read it" asks screenshot consent again even if the user declined screenshots earlier, so call this again only when the user asks about an image in a new message.',
    parameters: schema({
      id: { type: 'string' },
    }, ['id']),
  },
  {
    name: 'propose_action',
    description: 'Change the page. Low-risk steps (typing in ordinary fields, checking boxes, choosing options, toggling checkable cells or options, hovering) run immediately and can be undone; anything else waits for the user to confirm. Use ask_user first when required information is unclear; do not guess. Prefer set_value for ordinary form fields; set blur false only when the field must stay focused, for example to pick an autocomplete suggestion afterwards. A hover, blur, drag, screenshot point, double click, right click, held or modified click must be proposed alone. The result is {outcome, page}, where page is the page after the action.',
    parameters: schema({
      summary: { type: 'string', description: 'One sentence describing what will be done' },
      steps: { type: 'array', minItems: 1, maxItems: 20, items: stepSchema },
    }, ['summary', 'steps']),
  },
  {
    name: 'ask_user',
    description: 'Ask the user with short numbered options. The extension handles numbering, voice and keyboard selection.',
    parameters: schema({
      question: { type: 'string' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_OPTIONS,
        items: schema({ label: { type: 'string' }, value: { type: 'string' } }, ['label', 'value']),
      },
    }, ['question', 'options']),
  },
]);

export function toolByName(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

export function labelViolation(label) {
  const text = String(label ?? '').trim();
  if (!text) return 'Option label is empty';
  const words = text.split(/\s+/u).filter(Boolean);
  return words.length <= MAX_LABEL_WORDS && text.length <= MAX_LABEL_LATIN
    ? null
    : `Option label must be at most ${MAX_LABEL_WORDS} words and ${MAX_LABEL_LATIN} characters`;
}

export function normalizeAnswer(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[.!?\s]+$/u, '');
}

const answerKey = (value) => normalizeAnswer(value).toLowerCase();

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

export function parseChoiceNumber(raw) {
  const input = normalizeAnswer(raw).toLowerCase();
  const match = /^(?:option|choice|number)?\s*([1-9]|one|two|three|four|five|six|seven|eight|nine)$/u.exec(input);
  if (!match) return null;
  return NUMBER_WORDS[match[1]] ?? Number(match[1]);
}

export function createChoiceSet({ id, question, options, expiresAt = null }) {
  if (typeof question !== 'string') throw new Error('Question must be text');
  const text = question.trim();
  if (!text) throw new Error('Question is empty');
  if (text.length > 500) throw new Error('Question is too long');
  if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS) {
    throw new Error(`Option count must be between 1 and ${MAX_OPTIONS}`);
  }
  const seenLabels = new Set();
  const seenValues = new Set();
  const built = options.map((option, index) => {
    if (typeof option?.label !== 'string' || typeof option?.value !== 'string') {
      throw new Error(`Option ${index + 1} must have text for its label and value`);
    }
    const label = option.label.trim();
    const value = option.value.trim();
    const violation = labelViolation(label);
    if (violation) throw new Error(`Option ${index + 1}: ${violation}`);
    if (!value) throw new Error(`Option ${index + 1} is missing a value`);
    if (parseChoiceNumber(label) !== null) throw new Error(`Option label must not be only a number: ${label}`);
    const key = answerKey(label);
    if (seenLabels.has(key)) throw new Error(`Duplicate option label: ${label}`);
    const valueKey = answerKey(value);
    if (seenValues.has(valueKey)) throw new Error(`Duplicate option value: ${value}`);
    seenLabels.add(key);
    seenValues.add(valueKey);
    return { number: index + 1, label, value };
  });
  return {
    id: String(id),
    question: text,
    options: built,
    status: 'open',
    expiresAt,
    used: false,
  };
}

export function formatChoices(choiceSet) {
  if (!choiceSet) return '';
  return choiceSet.options
    .map((option) => `Choice ${option.number}. ${option.label}`)
    .join('. ');
}

export function resolveChoice(choiceSet, rawInput) {
  if (!choiceSet || choiceSet.status !== 'open' || choiceSet.used === true) return { ok: false, reason: 'closed' };
  if (choiceSet.expiresAt && Date.now() > choiceSet.expiresAt) return { ok: false, reason: 'expired' };
  const input = normalizeAnswer(rawInput);
  if (!input) return { ok: false, reason: 'empty' };
  const number = parseChoiceNumber(input);
  if (number !== null) {
    const option = choiceSet.options.find((candidate) => candidate.number === number);
    return option ? { ok: true, option } : { ok: false, reason: 'invalid' };
  }
  const lowered = answerKey(input);
  const byLabel = choiceSet.options.filter((option) => answerKey(option.label) === lowered);
  if (byLabel.length === 1) return { ok: true, option: byLabel[0] };
  const byValue = choiceSet.options.filter((option) => answerKey(option.value) === lowered);
  if (byValue.length === 1) return { ok: true, option: byValue[0] };
  return { ok: false, reason: byLabel.length + byValue.length > 1 ? 'ambiguous' : 'invalid' };
}

export function closeChoiceSet(choiceSet, reason = 'closed') {
  return choiceSet ? { ...choiceSet, status: reason, used: true } : choiceSet;
}
