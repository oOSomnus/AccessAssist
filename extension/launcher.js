// Always-available entrance. This script never reads the page, records audio
// or calls the model; it only reports a real click back to the worker, and,
// while the assistant asks a question, the real number keys that answer it.
(() => {
  if (globalThis.__accessAssistLauncher?.version === 1
    && globalThis.__accessAssistLauncher.host?.isConnected) return;

  const HOST_ID = 'accessassist-launcher-host';
  const DEFAULT_POSITION = { x: 1, y: 1 };
  const MARGIN = 16;
  const DRAG_THRESHOLD = 6;
  const MOVE_STEP = 16;
  const NUDGE = {
    ArrowUp: [0, -MOVE_STEP], ArrowDown: [0, MOVE_STEP],
    ArrowLeft: [-MOVE_STEP, 0], ArrowRight: [MOVE_STEP, 0],
  };
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const validPosition = (value) => Boolean(value)
    && typeof value === 'object'
    && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1
    && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.setProperty('all', 'initial');
  host.style.setProperty('position', 'fixed');
  host.style.setProperty('z-index', '2147483647');

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      /* Coral values, kept in step with extension/tokens.css. */
      --launcher-board: oklch(22% 0.011 40);
      --launcher-board-hover: oklch(29% 0.013 40);
      --launcher-board-type: oklch(96.5% 0.006 70);
      --launcher-mark-tile: oklch(54% 0.165 29);
      --launcher-mark-glyph: oklch(98.8% 0.0045 80);
      --launcher-focus: oklch(54% 0.17 30);
      --launcher-shadow: oklch(32% 0.03 50 / 0.3);
      --launcher-font: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .launcher-bar {
      display: inline-flex; align-items: center; gap: 8px;
      max-width: calc(100vw - 32px);
    }
    .open-button {
      display: inline-flex; align-items: center; gap: 10px;
      min-width: 56px; min-height: 56px; max-width: calc(100vw - 32px);
      padding: 0 18px 0 14px;
      border: 1px solid var(--launcher-board); border-radius: 8px;
      background: var(--launcher-board); color: var(--launcher-board-type);
      font: 600 18px/1.2 var(--launcher-font);
      box-shadow: 6px 5px 12px -6px var(--launcher-shadow);
      cursor: pointer; touch-action: none; user-select: none;
    }
    .open-button:hover, .open-button:active { border-color: var(--launcher-board-hover); background: var(--launcher-board-hover); }
    .mark { flex: none; display: block; width: 28px; height: 28px; }
    .mark-tile { fill: var(--launcher-mark-tile); }
    .mark-bubble { fill: var(--launcher-mark-glyph); }
    .mark-bars { fill: none; stroke: var(--launcher-mark-tile); stroke-width: 2.2; stroke-linecap: round; }
    .label { min-width: 0; overflow-wrap: anywhere; text-align: left; }
    .open-button:focus-visible {
      outline: 3px solid var(--launcher-focus); outline-offset: 3px;
    }
    .sr {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 240px) {
      .launcher-bar { flex-direction: column; align-items: stretch; gap: 6px; }
      .open-button { max-width: 100%; }
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --launcher-board: oklch(92% 0.008 55);
        --launcher-board-hover: oklch(86% 0.01 55);
        --launcher-board-type: oklch(20% 0.012 38);
        --launcher-focus: oklch(78% 0.13 30);
        --launcher-shadow: oklch(7% 0.01 40 / 0.5);
      }
    }
    @media (prefers-contrast: more) {
      .open-button { border-width: 2px; }
    }
    @media (forced-colors: active) {
      .open-button { border: 2px solid ButtonText; background: ButtonFace; color: ButtonText; box-shadow: none; }
      .open-button:hover, .open-button:active { border-color: ButtonText; background: ButtonFace; }
      .mark-tile { fill: ButtonText; }
      .mark-bubble { fill: ButtonFace; }
      .mark-bars { stroke: ButtonText; }
      .open-button:focus-visible { outline: 3px solid Highlight; }
    }
  `;

  const bar = document.createElement('div');
  bar.className = 'launcher-bar';

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.id = 'launcher-open';
  openButton.className = 'open-button';
  // Same glyph as sidepanel.html .brand-mark and icons/icon.svg.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attributes) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const mark = svgNode('svg', { class: 'mark', viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' });
  mark.append(
    svgNode('rect', { class: 'mark-tile', width: '32', height: '32', rx: '8' }),
    svgNode('path', { class: 'mark-bubble', d: 'M9 7h14a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-6 5v-5H9a4 4 0 0 1-4-4v-7a4 4 0 0 1 4-4z' }),
    svgNode('path', { class: 'mark-bars', d: 'M12 12.5v4M16 10.5v8M20 12.5v4' }),
  );
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Assistant';
  openButton.append(mark, label);
  openButton.setAttribute('aria-label', 'Open the AccessAssist assistant');
  openButton.setAttribute('aria-keyshortcuts', 'Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight');
  bar.append(openButton);

  const status = document.createElement('p');
  status.className = 'sr';
  status.setAttribute('role', 'status');

  root.append(style, bar, status);
  globalThis.__accessAssistLauncher = { version: 1, host };
  document.documentElement.append(host);

  let saved = { ...DEFAULT_POSITION };
  let committed = { ...DEFAULT_POSITION };
  let dragging = null;
  let loaded = false;
  let savePending = false;
  let suppressClick = false;

  function barRect() {
    return bar.getBoundingClientRect();
  }

  function positionPixels(position, rect) {
    const travelX = Math.max(0, innerWidth - rect.width - MARGIN * 2);
    const travelY = Math.max(0, innerHeight - rect.height - MARGIN * 2);
    return { left: MARGIN + position.x * travelX, top: MARGIN + position.y * travelY };
  }

  function pixelsPosition(left, top, rect) {
    const travelX = Math.max(0, innerWidth - rect.width - MARGIN * 2);
    const travelY = Math.max(0, innerHeight - rect.height - MARGIN * 2);
    return {
      x: travelX > 0 ? clamp((left - MARGIN) / travelX, 0, 1) : committed.x,
      y: travelY > 0 ? clamp((top - MARGIN) / travelY, 0, 1) : committed.y,
    };
  }

  function clampPixels(left, top, rect) {
    return {
      left: clamp(left, 0, innerWidth - rect.width),
      top: clamp(top, 0, innerHeight - rect.height),
    };
  }

  function applyPixels(left, top) {
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    const clamped = clampPixels(left, top, rect);
    host.style.setProperty('left', `${clamped.left}px`);
    host.style.setProperty('top', `${clamped.top}px`);
    host.style.setProperty('right', 'auto');
    host.style.setProperty('bottom', 'auto');
  }

  function render() {
    if (!host.isConnected) return;
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    if (dragging) {
      applyPixels(dragging.left, dragging.top);
      return;
    }
    const pixels = positionPixels(committed, rect);
    applyPixels(pixels.left, pixels.top);
  }

  async function persistPosition(position) {
    if (savePending) return;
    savePending = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SET_LAUNCHER_POSITION', position });
      if (response?.error) throw new Error(response.error);
      const next = validPosition(response?.position) ? response.position : position;
      saved = { x: next.x, y: next.y };
      committed = { ...saved };
      render();
      status.textContent = 'Assistant button position saved.';
    } catch (error) {
      committed = { ...saved };
      render();
      status.textContent = error?.message?.startsWith('Could not save')
        ? error.message
        : 'Could not save the Assistant button position. Try again.';
    } finally {
      savePending = false;
    }
  }

  function applyIncomingPosition(position) {
    if (!validPosition(position)) return;
    if (dragging) cancelDrag(false);
    saved = { x: position.x, y: position.y };
    committed = { ...saved };
    render();
  }

  function releaseCapture(gesture) {
    try {
      gesture.target.releasePointerCapture(gesture.pointerId);
    } catch {
      // The pointer may already be gone.
    }
  }

  function cancelDrag(announce = true) {
    if (!dragging) return;
    const gesture = dragging;
    dragging = null;
    releaseCapture(gesture);
    suppressClick = true;
    render();
    if (announce) status.textContent = 'Move cancelled.';
  }

  function beginPointer(event, target) {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    if (!loaded || savePending || dragging) return;
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    dragging = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      moved: false,
      target,
    };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimization; window-level cancellation still applies.
    }
  }

  function movePointer(event) {
    if (!dragging || event.pointerId !== dragging.pointerId || !event.isTrusted) return;
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    if (!dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!dragging.moved) {
      dragging.moved = true;
      dragging.target.focus({ preventScroll: true });
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = barRect();
    const left = event.clientX - dragging.grabX;
    const top = event.clientY - dragging.grabY;
    const clamped = clampPixels(left, top, rect);
    dragging.left = clamped.left;
    dragging.top = clamped.top;
    render();
  }

  function endPointer(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const gesture = dragging;
    dragging = null;
    releaseCapture(gesture);
    if (!gesture.moved) {
      render();
      return;
    }
    const rect = barRect();
    const clamped = clampPixels(gesture.left, gesture.top, rect);
    const position = pixelsPosition(clamped.left, clamped.top, rect);
    committed = position;
    suppressClick = true;
    render();
    void persistPosition(position);
  }

  function cancelPointer(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const gesture = dragging;
    dragging = null;
    releaseCapture(gesture);
    suppressClick = true;
    render();
    status.textContent = 'Move cancelled.';
  }

  openButton.addEventListener('pointerdown', (event) => beginPointer(event, openButton));
  openButton.addEventListener('pointermove', movePointer);
  openButton.addEventListener('pointerup', endPointer);
  openButton.addEventListener('pointercancel', cancelPointer);
  openButton.addEventListener('lostpointercapture', (event) => {
    if (dragging && dragging.pointerId === event.pointerId) cancelPointer(event);
  });

  openButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (suppressClick && event.detail > 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    status.textContent = '';
    chrome.runtime.sendMessage({ type: 'OPEN_ASSISTANT' }).then((response) => {
      if (response?.error) status.textContent = response.error;
    }).catch(() => {
      status.textContent = 'Could not open the assistant. Use the toolbar button or try again.';
    });
  });

  // Keyboard alternative to dragging: Shift+Arrow nudges and saves like a drag end.
  openButton.addEventListener('keydown', (event) => {
    const step = NUDGE[event.key];
    if (!event.isTrusted || !step || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (!loaded || savePending || dragging) return;
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    const clamped = clampPixels(rect.left + step[0], rect.top + step[1], rect);
    committed = pixelsPosition(clamped.left, clamped.top, rect);
    render();
    void persistPosition(committed);
  });

  root.addEventListener('keydown', (event) => {
    if (!event.isTrusted || !dragging || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  });

  window.addEventListener('blur', () => cancelDrag(false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelDrag(false);
    else scheduleRender();
  });
  let layoutFrame = 0;
  function scheduleRender() {
    if (dragging || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      render();
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        if (!dragging) render();
      });
    });
  }
  window.addEventListener('resize', scheduleRender);
  new ResizeObserver(scheduleRender).observe(bar);

  render();
  // While the assistant asks a question, Control+Shift and one of its numbers
  // answers it from this page too: keyboard focus is often here, not in the
  // panel. Only those keys, only then, and only real key presses; every other
  // key, and these keys at any other time, stay the page's.
  let choiceKeys = null;
  function applyChoiceKeys(value) {
    const numbers = Array.isArray(value?.numbers) ? value.numbers.filter((n) => /^[1-9]$/u.test(n)) : [];
    choiceKeys = typeof value?.choiceId === 'string' && numbers.length
      ? { choiceId: value.choiceId, numbers: new Set(numbers) }
      : null;
  }
  window.addEventListener('keydown', (event) => {
    if (!choiceKeys || !event.isTrusted || event.repeat || event.isComposing) return;
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
    const match = /^Digit([1-9])$/u.exec(event.code ?? '');
    if (!match || !choiceKeys.numbers.has(match[1])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'CHOICE_KEY', choiceId: choiceKeys.choiceId, key: match[1] })
      .then((response) => {
        if (response && 'choiceKeys' in response) applyChoiceKeys(response.choiceKeys);
      })
      .catch(() => {});
  }, true);

  chrome.runtime.sendMessage({ type: 'GET_LAUNCHER_STATE' }).then((state) => {
    if (state && 'choiceKeys' in state) applyChoiceKeys(state.choiceKeys);
    if (state?.error || !validPosition(state?.position)) throw new Error(state?.error ?? 'Invalid launcher position');
    saved = { x: state.position.x, y: state.position.y };
    committed = { ...saved };
    loaded = true;
    host.dataset.loaded = 'true';
    render();
  }).catch(() => {
    loaded = true;
    host.dataset.loaded = 'true';
    status.textContent = 'Could not load the Assistant button position. Try moving it again.';
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CHOICE_KEYS') applyChoiceKeys(message.choiceKeys);
    if (message?.type === 'SET_LAUNCHER_POSITION') applyIncomingPosition(message.position);
    if (message?.type === 'FOCUS_LAUNCHER') {
      if (dragging) cancelDrag(false);
      openButton.focus();
    }
  });

  // A replacement of <html> (SPA takeover, document rewrite) removes the host.
  const reattach = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };
  new MutationObserver(reattach).observe(document, { childList: true });
  new MutationObserver(reattach).observe(document.documentElement, { childList: true });
})();
