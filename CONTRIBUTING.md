# Contributing

Tests and packaging need Node and npm; the end-to-end tests use Playwright's bundled Chromium.

## Tests

```bash
npm install
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

On Linux hosts that lack browser system libraries, use `npx playwright install --with-deps chromium`.

`npm run test:e2e` starts local fixture pages and a scripted API, then loads the real extension in Chromium. It uses scripted speech, microphone, and audio boundaries, so it cannot prove native side-panel placement, audible cues, or real microphone behavior.

## Live AI check

```bash
npm run smoke:ai        # needs OPENCODE_ACCESS_KEY in .env
```

The check calls OpenCode Go with `deepseek-v4.1-flash` only. It covers one tool round trip, a PNG pixel round trip, and screenshot grounding for both API formats, and reports the Go billing source. Images are synthetic; no page or audio is uploaded.

The ChatGPT plan format runs too when `.env` sets `CHATGPT_ACCESS_TOKEN` and `CHATGPT_MODEL` (and optionally `CHATGPT_EFFORT`). To get a token, sign in with ChatGPT in the extension, then run `(await chrome.storage.session.get('chatgptAccess')).chatgptAccess.token` in the service worker's DevTools console. The token lasts an hour. Use `ONLY_PROTOCOL=chatgpt` to run just that check without an OpenCode key.

## Packaging

```bash
npm run package
```

Writes `accessassist.zip` with `manifest.json` at the archive root. The script needs the system `zip` and packs only `extension/`; `.env`, tests, and `node_modules` are outside it. Extract the archive and load the folder containing `manifest.json`. The `icons` entry ships as `extension/icons/icon-{16,32,48,128}.png`, rendered from `icon.svg`.
