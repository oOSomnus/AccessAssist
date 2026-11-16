# AccessAssist

AccessAssist is a Chrome side panel for blind users. It reads a page on command, confirms actions with numbered choices, asks before changing anything, and reports what it verified or can undo.

## Install

Requires Chrome 142 or later. No build step and no npm install: `extension/` is the whole extension.

1. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select the `extension/` folder.
2. Open a web page and press `Alt+Z`, or use the toolbar button or the "Assistant" button on the page. `Alt+Shift+Y` starts typing; `Alt+Shift+H` replays the introduction.
3. In Settings, paste an OpenCode Go API key and save. The panel has a "Get an API key" link. The key lasts for this browser session, and changing the API origin clears it.

## Voice

Press `Alt+Z` for one command. The panel says Listening and plays a short high tone when the microphone starts; speak after the tone. It reads the recognized words back, then says it is working before the task starts. If the tone cannot play, the panel says the start sound is unavailable and still listens. It listens only when you press `Alt+Z`: answers, pauses, and panel button taps do not reopen the microphone.

The first `Alt+Z` also downloads Chrome's English speech pack and asks for microphone access. If you dismissed the prompt or Chrome blocked it, choose Prepare voice or Retry. If the side panel cannot show the prompt, it opens a setup tab once; finish Prepare voice there, then choose Return to assistant. You can type in the Message box at any time.

### Local speech versus the AI service

Speech recognition runs on this device. The speech pack download needs a network connection, and recognition does not fall back to Google's online speech service. Your spoken commands and any page content you allow go to the configured AI service for page understanding.

## Reading and acting

AccessAssist handles ordinary buttons, links, and form fields, plus common custom controls such as time grids built from table cells. Before it reads page text, it lists the current site and every embedded source in one confirmation. "Allow listed sites" reads that whole snapshot; "Current site only" leaves embedded sites unread. A source that appears later gets its own confirmation. Screenshots and page changes need separate consent.

A screenshot can guide a click or drag on visual targets such as canvases, but only on a page with no embedded frame and no password field, including hidden fields and fields inside shadow roots. AccessAssist refuses the screenshot on those pages rather than masking it; page text and ordinary controls still work. A screenshot stays in memory, maps to one observation and viewport position, and expires when the page scrolls or navigates.

Some custom controls save a change as soon as they are clicked. The panel says whether it saw a change and whether it verified the requested result, asks again before an action it cannot undo, and never claims a color change or server save it could not confirm.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, the live AI check, and packaging.

## Known limits

- OpenCode Go is designed for coding-agent requests. This project's use of the service has not been confirmed by OpenCode.
- Native side-panel placement, audible speech, microphone recognition, VoiceOver, and Narrator still need testing on real devices and operating systems.
- A managed browser policy can block the English speech pack or microphone.
