// Always-available entrance. This script never reads the page, records audio
// or calls the model; it only reports a real click back to the worker.
(() => {
  if (globalThis.__accessAssistLauncher?.version === 1
    && globalThis.__accessAssistLauncher.host?.isConnected) return;

  const HOST_ID = 'accessassist-launcher-host';
  const DEFAULT_POSITION = { x: 1, y: 1 };
  const MARGIN = 16;
  const DRAG_THRESHOLD = 6;
  const MOVE_STEP = 16;
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
      --launcher-accent: #6534d5;
      --launcher-accent-hover: #5225b5;
      --launcher-on-accent: #ffffff;
      --launcher-mark-bg: #ffffff;
      --launcher-mark-fg: #5225b5;
      --launcher-focus: #8f2dce;
      --launcher-shadow: rgba(24, 32, 48, 0.28);
      --launcher-panel-bg: #ffffff;
      --launcher-panel-fg: #1a1a1a;
      --launcher-panel-border: #6534d5;
    }
    .launcher-bar {
      display: inline-flex; align-items: center; gap: 8px;
      max-width: calc(100vw - 32px);
    }
    .open-button {
      display: inline-flex; align-items: center; gap: 8px;
      min-width: 56px; min-height: 56px; max-width: calc(100vw - 32px);
      padding: 0 18px 0 14px;
      border: 1px solid var(--launcher-accent); border-radius: 28px;
      background: var(--launcher-accent); color: var(--launcher-on-accent);
      font: 600 18px/1.2 system-ui, sans-serif;
      box-shadow: 0 4px 14px var(--launcher-shadow);
      cursor: pointer; touch-action: none; user-select: none;
    }
    .open-button:hover, .open-button:active { border-color: var(--launcher-accent-hover); background: var(--launcher-accent-hover); }
    .launcher-move {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 44px; min-height: 44px; padding: 0 14px;
      border: 1px solid var(--launcher-accent); border-radius: 22px;
      background: var(--launcher-on-accent); color: var(--launcher-accent);
      font: 600 16px/1.2 system-ui, sans-serif;
      box-shadow: 0 4px 14px var(--launcher-shadow);
      cursor: pointer; touch-action: none; user-select: none;
    }
    .launcher-move:hover, .launcher-move:active { border-color: var(--launcher-accent-hover); color: var(--launcher-accent-hover); }
    .mark {
      flex: none; display: grid; place-items: center;
      width: 28px; height: 28px; border-radius: 9px;
      background: var(--launcher-mark-bg); color: var(--launcher-mark-fg); font-size: 16px;
    }
    .label { min-width: 0; overflow-wrap: anywhere; text-align: left; }
    .open-button:focus-visible, .launcher-move:focus-visible, .move-panel button:focus-visible {
      outline: 3px solid var(--launcher-focus); outline-offset: 3px;
    }
    .move-panel {
      position: fixed; box-sizing: border-box;
      width: 240px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px); overflow: auto;
      padding: 12px; border: 1px solid var(--launcher-panel-border); border-radius: 12px;
      background: var(--launcher-panel-bg); color: var(--launcher-panel-fg);
      box-shadow: 0 4px 14px var(--launcher-shadow);
      font: 400 16px/1.4 system-ui, sans-serif;
    }
    .move-panel[hidden] { display: none; }
    .move-help { margin: 0 0 8px; }
    .move-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 8px; }
    .move-grid button {
      min-width: 44px; min-height: 44px; padding: 8px;
      border: 1px solid var(--launcher-panel-border); border-radius: 10px;
      background: var(--launcher-panel-bg); color: inherit;
      font: inherit; cursor: pointer;
    }
    .move-grid button:hover, .move-grid button:active { border-color: var(--launcher-accent-hover); }
    .move-grid button:disabled, .launcher-move:disabled { cursor: default; opacity: 0.65; }
    .sr {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    @media (max-width: 240px) {
      .launcher-bar { flex-direction: column; align-items: stretch; gap: 6px; }
      .open-button { max-width: 100%; border-radius: 24px; }
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --launcher-accent: #bca1ff;
        --launcher-accent-hover: #cfbdff;
        --launcher-on-accent: #201238;
        --launcher-mark-bg: #201238;
        --launcher-mark-fg: #f7f9fd;
        --launcher-focus: #e0b7ff;
        --launcher-shadow: rgba(0, 0, 0, 0.45);
        --launcher-panel-bg: #201238;
        --launcher-panel-fg: #f7f9fd;
        --launcher-panel-border: #bca1ff;
      }
    }
    @media (prefers-contrast: more) {
      .open-button, .launcher-move, .move-panel, .move-grid button { border-width: 2px; }
    }
    @media (forced-colors: active) {
      .open-button, .launcher-move, .move-panel, .move-grid button {
        border: 2px solid ButtonText; background: ButtonFace; color: ButtonText;
        box-shadow: none;
      }
      .mark { border: 1px solid ButtonText; background: ButtonText; color: ButtonFace; }
      .open-button:hover, .open-button:active,
      .launcher-move:hover, .launcher-move:active,
      .move-grid button:hover, .move-grid button:active {
        border-color: ButtonText; background: ButtonFace;
      }
      .open-button:focus-visible, .launcher-move:focus-visible,
      .move-panel button:focus-visible { outline: 3px solid Highlight; }
    }
    @media (prefers-reduced-motion: reduce) {
      .open-button, .launcher-move, .move-grid button { transition: none; }
    }
  `;

  const bar = document.createElement('div');
  bar.className = 'launcher-bar';

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.id = 'launcher-open';
  openButton.className = 'open-button';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'A';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Assistant';
  openButton.append(mark, label);
  openButton.setAttribute('aria-label', 'Open the AccessAssist assistant');

  const moveButton = document.createElement('button');
  moveButton.type = 'button';
  moveButton.id = 'launcher-move';
  moveButton.className = 'launcher-move';
  moveButton.textContent = 'Move';
  moveButton.setAttribute('aria-label', 'Move Assistant button');
  moveButton.setAttribute('aria-expanded', 'false');
  moveButton.setAttribute('aria-controls', 'launcher-move-controls');
  bar.append(openButton, moveButton);

  const movePanel = document.createElement('div');
  movePanel.id = 'launcher-move-controls';
  movePanel.className = 'move-panel';
  movePanel.setAttribute('role', 'group');
  movePanel.setAttribute('aria-label', 'Move Assistant button');
  movePanel.setAttribute('aria-describedby', 'launcher-move-help');
  movePanel.hidden = true;
  const moveHelp = document.createElement('p');
  moveHelp.id = 'launcher-move-help';
  moveHelp.className = 'move-help';
  moveHelp.textContent = 'Use the direction buttons or arrow keys to move. Choose Done to save or Cancel to restore.';
  const moveGrid = document.createElement('div');
  moveGrid.className = 'move-grid';
  const directions = [
    ['up', 0, -MOVE_STEP, 'Move up'],
    ['down', 0, MOVE_STEP, 'Move down'],
    ['left', -MOVE_STEP, 0, 'Move left'],
    ['right', MOVE_STEP, 0, 'Move right'],
  ];
  const directionButtons = directions.map(([name, dx, dy, accessibleName]) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.dataset.direction = name;
    control.textContent = name[0].toUpperCase() + name.slice(1);
    control.setAttribute('aria-label', accessibleName);
    control.addEventListener('click', (event) => {
      if (!event.isTrusted || !moveOpen || savePending) return;
      moveBy(dx, dy);
    });
    moveGrid.append(control);
    return control;
  });
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.textContent = 'Done';
  doneButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    closeMovePanel({ persist: true, focus: true });
  });
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    closeMovePanel({ focus: true });
  });
  moveGrid.append(doneButton, cancelButton);
  movePanel.append(moveHelp, moveGrid);

  const status = document.createElement('p');
  status.className = 'sr';
  status.setAttribute('role', 'status');

  root.append(style, bar, movePanel, status);
  globalThis.__accessAssistLauncher = { version: 1, host };
  document.documentElement.append(host);

  let saved = { ...DEFAULT_POSITION };
  let committed = { ...DEFAULT_POSITION };
  let preview = null;
  let dragging = null;
  let loaded = false;
  let savePending = false;
  let moveOpen = false;
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
    const base = preview ?? committed;
    return {
      x: travelX > 0 ? clamp((left - MARGIN) / travelX, 0, 1) : base.x,
      y: travelY > 0 ? clamp((top - MARGIN) / travelY, 0, 1) : base.y,
    };
  }

  function clampPixels(left, top, rect) {
    return {
      left: clamp(left, 0, innerWidth - rect.width),
      top: clamp(top, 0, innerHeight - rect.height),
    };
  }

  function placeMovePanel(rect) {
    if (!moveOpen) return;
    const width = movePanel.offsetWidth;
    const height = movePanel.offsetHeight;
    let left = clamp(rect.left, MARGIN, innerWidth - width - MARGIN);
    let top = rect.top - height - 8;
    if (top < MARGIN) top = rect.bottom + 8;
    top = clamp(top, MARGIN, innerHeight - height - MARGIN);
    left = clamp(left, MARGIN, Math.max(MARGIN, innerWidth - width - MARGIN));
    top = clamp(top, MARGIN, Math.max(MARGIN, innerHeight - height - MARGIN));
    movePanel.style.setProperty('left', `${left}px`);
    movePanel.style.setProperty('top', `${top}px`);
  }

  function applyPixels(left, top) {
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    const clamped = clampPixels(left, top, rect);
    host.style.setProperty('left', `${clamped.left}px`);
    host.style.setProperty('top', `${clamped.top}px`);
    host.style.setProperty('right', 'auto');
    host.style.setProperty('bottom', 'auto');
    if (moveOpen) placeMovePanel(rect);
  }

  function render() {
    if (!host.isConnected) return;
    const rect = barRect();
    if (!rect.width || !rect.height) return;
    if (dragging) {
      applyPixels(dragging.left, dragging.top);
      return;
    }
    const pixels = positionPixels(preview ?? committed, rect);
    applyPixels(pixels.left, pixels.top);
  }

  function setControlsDisabled() {
    moveButton.disabled = !loaded || savePending;
    for (const control of [directionButtons, [doneButton, cancelButton]].flat()) {
      control.disabled = savePending;
    }
  }

  function announcePosition() {
    const position = preview ?? committed;
    status.textContent = `Position: ${Math.round(position.x * 100)} percent across, ${Math.round(position.y * 100)} percent down.`;
  }

  function moveBy(dx, dy) {
    if (!moveOpen || savePending) return;
    const rect = barRect();
    const clamped = clampPixels(rect.left + dx, rect.top + dy, rect);
    preview = pixelsPosition(clamped.left, clamped.top, rect);
    render();
    announcePosition();
  }

  function focusMoveButton() {
    moveButton.focus({ preventScroll: true });
  }

  function openMovePanel() {
    if (!loaded || savePending || moveOpen) return;
    preview = { ...committed };
    moveOpen = true;
    movePanel.hidden = false;
    moveButton.setAttribute('aria-expanded', 'true');
    render();
    directionButtons[0].focus({ preventScroll: true });
  }

  function closeMovePanel({ persist = false, focus = false } = {}) {
    if (!moveOpen) return;
    const target = persist && preview ? { ...preview } : null;
    moveOpen = false;
    movePanel.hidden = true;
    moveButton.setAttribute('aria-expanded', 'false');
    preview = null;
    if (target) committed = target;
    render();
    if (focus) focusMoveButton();
    if (target) void persistPosition(target);
  }

  async function persistPosition(position) {
    if (savePending) return;
    savePending = true;
    setControlsDisabled();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SET_LAUNCHER_POSITION', position });
      if (response?.error) throw new Error(response.error);
      const next = validPosition(response?.position) ? response.position : position;
      saved = { x: next.x, y: next.y };
      committed = { ...saved };
      preview = null;
      render();
      status.textContent = 'Assistant button position saved.';
    } catch (error) {
      committed = { ...saved };
      preview = null;
      render();
      status.textContent = error?.message?.startsWith('Could not save')
        ? error.message
        : 'Could not save the Assistant button position. Try again.';
    } finally {
      savePending = false;
      setControlsDisabled();
    }
  }

  function applyIncomingPosition(position) {
    if (!validPosition(position)) return;
    const focusWasInside = moveOpen && movePanel.contains(root.activeElement);
    if (dragging) cancelDrag(false);
    if (moveOpen) closeMovePanel();
    saved = { x: position.x, y: position.y };
    committed = { ...saved };
    preview = null;
    render();
    if (focusWasInside) focusMoveButton();
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
    preview = null;
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
      if (moveOpen) closeMovePanel();
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
    preview = null;
    suppressClick = true;
    render();
    void persistPosition(position);
  }

  function cancelPointer(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const gesture = dragging;
    dragging = null;
    releaseCapture(gesture);
    preview = null;
    suppressClick = true;
    render();
    status.textContent = 'Move cancelled.';
  }

  openButton.addEventListener('pointerdown', (event) => beginPointer(event, openButton));
  moveButton.addEventListener('pointerdown', (event) => beginPointer(event, moveButton));
  for (const target of [openButton, moveButton]) {
    target.addEventListener('pointermove', movePointer);
    target.addEventListener('pointerup', endPointer);
    target.addEventListener('pointercancel', cancelPointer);
    target.addEventListener('lostpointercapture', (event) => {
      if (dragging && dragging.pointerId === event.pointerId) cancelPointer(event);
    });
  }

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

  moveButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (suppressClick && event.detail > 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (savePending) return;
    if (moveOpen) closeMovePanel({ persist: true, focus: true });
    else openMovePanel();
  });

  root.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    if (dragging) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
      return;
    }
    if (!moveOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMovePanel({ focus: true });
      return;
    }
    const deltas = {
      ArrowUp: [0, -MOVE_STEP],
      ArrowDown: [0, MOVE_STEP],
      ArrowLeft: [-MOVE_STEP, 0],
      ArrowRight: [MOVE_STEP, 0],
    };
    if (!(event.key in deltas) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const active = root.activeElement;
    if (active !== moveButton && !movePanel.contains(active)) return;
    event.preventDefault();
    event.stopPropagation();
    moveBy(...deltas[event.key]);
  });

  const focusInsideHost = (node) => node === host || bar.contains(node) || movePanel.contains(node);

  root.addEventListener('focusout', (event) => {
    if (!moveOpen) return;
    const next = event.relatedTarget;
    if (next && focusInsideHost(next)) return;
    closeMovePanel();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || !moveOpen || event.composedPath().includes(host)) return;
    closeMovePanel();
  }, true);

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

  setControlsDisabled();
  render();
  chrome.runtime.sendMessage({ type: 'GET_LAUNCHER_STATE' }).then((state) => {
    if (state?.error || !validPosition(state?.position)) throw new Error(state?.error ?? 'Invalid launcher position');
    saved = { x: state.position.x, y: state.position.y };
    committed = { ...saved };
    loaded = true;
    render();
    setControlsDisabled();
  }).catch(() => {
    loaded = true;
    setControlsDisabled();
    status.textContent = 'Could not load the Assistant button position. Try moving it again.';
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SET_LAUNCHER_POSITION') applyIncomingPosition(message.position);
    if (message?.type === 'FOCUS_LAUNCHER') {
      if (dragging) cancelDrag(false);
      if (moveOpen) closeMovePanel();
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
