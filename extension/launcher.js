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
    :host {
      all: initial;
      --launcher-accent: #6534d5;
      --launcher-accent-hover: #5225b5;
      --launcher-on-accent: #ffffff;
      --launcher-mark-bg: #ffffff;
      --launcher-mark-fg: #5225b5;
      --launcher-focus: #8f2dce;
      --launcher-shadow: rgba(24, 32, 48, 0.28);
    }
    button {
      display: inline-flex; align-items: center; gap: 8px;
      min-width: 56px; min-height: 56px; max-width: calc(100vw - 32px);
      padding: 0 18px 0 14px;
      border: 1px solid var(--launcher-accent); border-radius: 28px;
      background: var(--launcher-accent); color: var(--launcher-on-accent);
      font: 600 18px/1.2 system-ui, sans-serif;
      box-shadow: 0 4px 14px var(--launcher-shadow);
      cursor: pointer;
    }
    button:hover, button:active { border-color: var(--launcher-accent-hover); background: var(--launcher-accent-hover); }
    .mark {
      flex: none; display: grid; place-items: center;
      width: 28px; height: 28px; border-radius: 9px;
      background: var(--launcher-mark-bg); color: var(--launcher-mark-fg); font-size: 16px;
    }
    .label { min-width: 0; overflow-wrap: anywhere; text-align: left; }
    button:focus-visible { outline: 3px solid var(--launcher-focus); outline-offset: 3px; }
    @media (prefers-color-scheme: dark) {
      :host {
        --launcher-accent: #bca1ff;
        --launcher-accent-hover: #cfbdff;
        --launcher-on-accent: #201238;
        --launcher-mark-bg: #201238;
        --launcher-mark-fg: #f7f9fd;
        --launcher-focus: #e0b7ff;
        --launcher-shadow: rgba(0, 0, 0, 0.45);
      }
    }
    @media (prefers-contrast: more) { button { border-width: 2px; } }
    @media (forced-colors: active) {
      button {
        border: 2px solid ButtonText; background: ButtonFace; color: ButtonText;
        box-shadow: none;
      }
      .mark { border: 1px solid ButtonText; background: ButtonText; color: ButtonFace; }
      button:hover, button:active { border-color: ButtonText; background: ButtonFace; }
      button:focus-visible { outline: 3px solid Highlight; }
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    .sr {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'A';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Assistant';
  button.append(mark, label);
  button.setAttribute('aria-label', 'Open the AccessAssist assistant');
  const status = document.createElement('p');
  status.className = 'sr';
  status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    status.textContent = '';
    chrome.runtime.sendMessage({ type: 'OPEN_ASSISTANT' }).then((response) => {
      if (response?.error) status.textContent = response.error;
    }).catch(() => {
      status.textContent = 'Could not open the assistant. Use the toolbar button or try again.';
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
