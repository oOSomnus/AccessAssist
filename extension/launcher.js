// Always-available entrance. This script never reads the page, records audio
// or calls the model; it only reports a real click back to the worker.
(() => {
  if (globalThis.__accessAssistLauncher?.version === 1
    && globalThis.__accessAssistLauncher.host?.isConnected) return;

  const HOST_ID = 'accessassist-launcher-host';
  const POSITIONS = {
    br: 'right:16px;bottom:16px;',
    bl: 'left:16px;bottom:16px;',
    tr: 'right:16px;top:16px;',
    tl: 'left:16px;top:16px;',
  };

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = `all:initial;position:fixed;z-index:2147483647;${POSITIONS.br}`;

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    button {
      min-width: 56px; min-height: 56px; padding: 0 18px;
      border: 2px solid #ffffff; border-radius: 28px;
      background: #111111; color: #ffffff;
      font: 600 18px/1.2 system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
      cursor: pointer;
    }
    button:focus-visible { outline: 4px solid #ffbf47; outline-offset: 3px; }
    @media (prefers-contrast: more) { button { background: #000000; border-color: #ffff00; } }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    .sr {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Assistant';
  button.setAttribute('aria-label', 'Open the AccessAssist voice assistant, shortcut Alt+Z');
  const status = document.createElement('p');
  status.className = 'sr';
  status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    status.textContent = '';
    chrome.runtime.sendMessage({ type: 'OPEN_ASSISTANT' }).then((response) => {
      if (response?.error) status.textContent = response.error;
    }).catch(() => {
      status.textContent = 'Could not open the assistant. Press Alt+Z or use the toolbar button.';
    });
  });
  root.append(style, button, status);
  globalThis.__accessAssistLauncher = { version: 1, host };
  document.documentElement.append(host);

  const applyPosition = (position) => {
    host.style.cssText = `all:initial;position:fixed;z-index:2147483647;${POSITIONS[position] ?? POSITIONS.br}`;
  };

  chrome.runtime.sendMessage({ type: 'GET_LAUNCHER_STATE' }).then((state) => {
    applyPosition(state?.position);
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SET_LAUNCHER_POSITION') applyPosition(message.position);
    if (message?.type === 'FOCUS_LAUNCHER') button.focus();
  });

  // A replacement of <html> (SPA takeover, document rewrite) removes the host.
  const reattach = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };
  new MutationObserver(reattach).observe(document, { childList: true });
  new MutationObserver(reattach).observe(document.documentElement, { childList: true });
})();
