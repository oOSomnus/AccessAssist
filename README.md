# AccessAssist

AccessAssist is a Chrome side panel for blind users. It reads a page on command, confirms actions with numbered choices, asks before changing anything, and reports what it verified or can undo.

## Install

Requires Chrome 142 or later. No build step and no npm install: `extension/` is the whole extension.

1. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select the `extension/` folder.
2. Open a web page and press `Control+Shift+Space` (physical Control on macOS too), or use the toolbar button or the "Assistant" button on the page. This opens or focuses the panel without recording. Drag the Assistant button anywhere in the viewport to move it, or focus it and press Shift+Arrow to nudge it; the position is remembered. After updating the extension, reload already open pages to get the new button.
3. Press `Control+Shift+Y` for one dictated command, or choose Listen. `Control+Shift+Period` closes the panel. Replay introduction has no default key; use the Settings button or assign one at `chrome://extensions/shortcuts`. An existing profile keeps its saved key until you rebind Close panel there once.
4. In Settings, paste an OpenCode Go API key and save. The panel has a "Get an API key" link. The key lasts for this browser session, and changing the API origin clears it. Advanced API settings also include Reasoning effort. Provider default sends no effort parameter; supported levels depend on the model, and some models map levels to the same behavior.

The shortcuts use physical Control, not Command, so they avoid macOS Command+Shift screenshot keys. Distribute them across both sides of the keyboard or use the native buttons and system sticky keys; no timed key sequence is required.

## Voice

Press `Control+Shift+Y` or choose Listen for one command. The system screen reader says "Listening", then two high tones mean the microphone is ready; speak after the second tone. The panel waits up to 15 seconds for you to start and about 2 seconds between phrases, then joins your finalized phrases into one instruction. A 60-second cap keeps a stuck recognizer from holding the microphone. AccessAssist recognizes one isolated microphone track with system echo cancellation and never falls back to a default input; if that isolation is unavailable, it says so and does not record. It reads the recognized words back, then announces that it is working before the task starts. It listens only for that request: answers, pauses, the main open shortcut, and panel button taps do not reopen the microphone. Recognized speech is used automatically after the readback; there is no extra Send step.

The first Listen or Prepare voice downloads Chrome's English speech pack and asks for microphone access. If you dismissed the prompt or Chrome blocked it, choose Prepare voice or Retry. If the side panel cannot show the prompt, it opens a setup tab once; finish Prepare voice there, then choose Return to assistant. Voice is the only input; the panel has no text box.

### Speech output

AccessAssist always uses the system screen reader: every status, readback, question, and answer is appended to a live region, and VoiceOver or Narrator speaks it. There is no extension voice or output selector. A live region confirms delivery to the page, not that a screen reader finished speaking. The working pattern plays while a request runs, and each numbered choice is named before its source sites. Choice numbers use `Control+Shift+1` through `Control+Shift+9` in the panel; plain digits stay with your screen reader. Pressing `Control+Shift+Space` asks the panel to take keyboard focus and focuses the current choice, or the Listen button when there is no question. Chrome can still keep native side-panel focus on the page in some versions; then use F6/Shift+F6 on Windows or Command+Option+Up/Down on macOS to reach the assistant, then Tab.

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
- Automated tests use a scripted voice and an extension tab; they cannot prove OS shortcut registration, native side-panel focus or closure, audible speech, or real VoiceOver and Narrator behavior. Check those on Windows and macOS with the actual side panel.
- Side-panel keyboard focus belongs to Chrome. The panel focuses the current choice, but Chrome builds before 148 may leave browser focus on the page when the shortcut opens the panel; Chrome 148 beta and later reportedly fix that handoff. Until then, use F6/Shift+F6 on Windows or Command+Option+Up/Down on macOS.
- A managed browser policy can block the English speech pack or microphone.
