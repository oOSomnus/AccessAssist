# Contributing

Node 20.6 or later and npm are needed for the tests, the live checks, and packaging. End-to-end tests use Playwright's Chromium.

## Tests

```bash
npm install
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

On Linux hosts that lack browser system libraries, install them with:

```bash
npx playwright install --with-deps chromium
```

`npm run test:unit` runs the Node test suite. `npm run test:e2e` starts the fixture pages and the scripted model API from `test/serve-fixtures.mjs`, then loads the real extension in Chromium. Speech recognition, the microphone, and cue audio are stubbed, so the tests cannot prove OS shortcut registration, native side-panel focus or closure, audible cues, real microphone behavior, or real screen-reader output. They do check the order in which the panel delivers announcements.

## Live AI check

```bash
npm run smoke:ai        # needs OPENCODE_ACCESS_KEY in .env
```

By default the command loads `.env` and calls OpenCode Go with `deepseek-v4.1-flash` only. For each Go endpoint (OpenAI-compatible and Anthropic-compatible), it runs one tool round trip, a synthetic-PNG OCR round trip, and screenshot grounding. It reports the Go billing source. No real page or audio is uploaded.

The ChatGPT plan check also runs when `.env` sets `CHATGPT_ACCESS_TOKEN` and `CHATGPT_MODEL`; `CHATGPT_EFFORT` is optional. To get a token, sign in with ChatGPT in the extension, then run this in the service worker's DevTools console:

```js
(await chrome.storage.session.get('chatgptAccess')).chatgptAccess.token
```

The access token expires in about an hour. Use `ONLY_PROTOCOL=chatgpt` to run just that check without an OpenCode key; `ONLY_PROTOCOL=openai` or `ONLY_PROTOCOL=anthropic` selects one Go endpoint.

## Packaging

```bash
npm run package
```

This writes `accessassist.zip` with `manifest.json` at the archive root. The system `zip` command is required. The script packs only `extension/`, so `.env`, tests, and `node_modules` are not included. Extract the archive and load the folder containing `manifest.json`.

The archive contains the icons as `icons/icon-{16,32,48,128}.png`; their sources are in `extension/icons/`.
