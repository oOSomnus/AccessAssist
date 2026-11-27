# AccessAssist

AccessAssist is a Chrome side panel for blind users. It reads a page on command, offers numbered choices for decisions, runs changes it can undo, and asks before changing anything it cannot undo. It reports what it verified or can undo.

## Install

Requires Chrome 142 or later. There is no build step and, to use the extension, no npm install: `extension/` is the complete extension.

1. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select the `extension/` folder.
2. Open a web page and press `Control+Shift+Space` (physical Control on macOS too), use the toolbar button, or use the "Assistant" button on the page. This opens or focuses the panel without recording. Drag the Assistant button to move it, or focus it and press Shift+Arrow to nudge it. The position is remembered. After updating the extension, reload open pages to get the new button.
3. Press `Control+Shift+Y` for one dictated command, or choose Listen. `Control+Shift+Period` closes the panel. Replay introduction has no default key: use the button in Settings or assign one at `chrome://extensions/shortcuts`.
4. In Settings, choose a model service:
   - **OpenCode Go API key**: paste an OpenCode Go API key and save. The "Get an API key" link opens the OpenCode console. The key lasts for this browser session, and changing the API origin clears it. Advanced API settings set the API format, address, model, Anthropic version, and reasoning effort. "Provider default" sends no effort parameter; supported levels depend on the model, and some models map levels to the same behavior.
   - **ChatGPT plan**: choose "Continue with ChatGPT" and sign in. Then choose a model and a reasoning effort and save. The model list shows the models your account can use. Requests use the usage included in your ChatGPT plan through OpenAI's Sign in with ChatGPT program, not an API key. The account stays signed in across browser restarts until you sign out or OpenAI ends the sign-in. A pasted OpenCode key is kept while ChatGPT is chosen, so you can switch back. See [Signing in with ChatGPT](#signing-in-with-chatgpt).

The shortcuts use physical Control, not Command, so they avoid macOS Command+Shift screenshot shortcuts. Use both sides of the keyboard, the native buttons, or system sticky keys; no timed key sequence is required.

### Signing in with ChatGPT

The sign-in tab belongs to OpenAI. AccessAssist never reads, captures, or operates it, even though it is a normal web page, and it never sees your password.

When OpenAI redirects to `http://127.0.0.1:1455/auth/callback`, AccessAssist reads the one-time code from the navigation itself, exchanges it for tokens, returns you to your page, and closes the sign-in tab. Nothing needs to listen on that port.

The long-lived sign-in is kept in the browser profile, readable only by the extension. The short-lived access token is kept only for this browser session. "Sign out of ChatGPT" deletes both and asks OpenAI to end the sign-in.

## Voice

Press `Control+Shift+Y` or choose Listen for one command. The system screen reader says "Listening", then two high tones mean the microphone is ready; speak after the second tone. The panel waits up to 15 seconds for speech to start and about 2 seconds between phrases, then joins your finalized phrases into one instruction. A 60-second cap keeps a stuck recognizer from holding the microphone.

AccessAssist uses one isolated microphone track with system echo cancellation and never falls back to a default input. If that isolation is unavailable, it says so and does not record. It reads the recognized words back, then announces that it is working before the task starts. Recognized speech is used automatically after the readback; there is no Send step. It does not reopen the microphone after an answer or a pause, and the open shortcut or other panel buttons never start listening; only Listen or the listen shortcut starts a new command.

The first Listen or Prepare voice downloads Chrome's English speech pack and asks for microphone access. If you dismissed the prompt or Chrome blocked it, choose Prepare voice or Retry. If the side panel cannot show the prompt, it opens a setup tab once; finish Prepare voice there, then choose Return to assistant. Commands are voice-only; the panel has no command text box.

### Speech output

AccessAssist uses the system screen reader, not its own voice. One live region carries the conversation, including status reports, readbacks, questions, and answers, and VoiceOver, Narrator, NVDA, or JAWS speaks it. Setup and Settings also have visible status lines. There is no extension voice or output selector. A live region confirms delivery to the page, not that a screen reader finished speaking.

The panel requests keyboard focus when it opens and loads hidden from screen readers (not from view), so a reader that reads a freshly loaded page aloud, such as VoiceOver with "speak web page" on, finds nothing. Once the panel knows why it opened, it exposes Listen and puts focus there, so a screen reader names that button instead of reading the whole panel. The rest appears to the reader on the first key press, click, or focus move, or about a second and a half later.

A cold listen shortcut is different: the panel stays hidden from screen readers while you dictate, so the panel is not read over the prompt and tone. It appears when listening ends, sooner on a key press, click, or focus move in the panel, or after 30 seconds if listening never reports an end. When it appears, focus goes to Listen unless a panel control already has it.

One live region, written one message at a time, is deliberate. The panel queues its messages and holds each one for an estimate of how long a reader needs, capped at six seconds, so the order you hear is the order the panel intended rather than one each screen reader resolves for itself. An urgent message drops waiting status messages and goes next, ahead of everything except earlier urgent messages. An open question stays queued until it is answered or closed. The panel waits only for the current estimated hold; it cannot tell when the reader actually finishes, so a long message, or a reader set to a slow rate, may still be speaking when the next message arrives. Each message is announced once and then cleared, so the region does not become a second, stale copy of the conversation to wander into; the transcript keeps the durable copy.

The working tone plays while a request runs and stays quiet while a message is still being read.

### Choice keys

Each numbered choice is named before its source sites. Choice numbers use `Control+Shift+1` through `Control+Shift+9`; plain digits stay with your screen reader. They work wherever focus is in the panel: a number the focused group does not use goes to the visible control that shows it, and a number nothing uses is answered with "Nothing uses Control plus Shift plus 9 right now."

While a question is open, its numbers also answer it from the page in front, because keyboard focus is often there. Only those numbers, only while the question is open, and only real key presses are caught, so the page keeps every other key. `Control+Shift+Space` never presses the panel control that has focus.

The choice keys are not read out with every question; they are in the introduction, in Settings, and on screen. Pressing `Control+Shift+Space` asks the panel to take keyboard focus and focuses the current choice, or Listen when there is no question. Chrome still owns native side-panel focus; if it leaves focus on the page, see [Known limits](#known-limits).

### Which screen reader you use

Settings has a Screen reader choice. It affects only the keys AccessAssist reads out when you want to explore an image with your own reader, and it covers Narrator, NVDA, JAWS, and VoiceOver. A web page cannot detect a screen reader, only the operating system. With "Detect from this system", macOS selects VoiceOver; on Windows the panel asks once which reader you run and remembers the answer.

### Local speech versus the AI service

Speech recognition runs on this device. The speech pack download needs a network connection, and recognition does not fall back to Google's online speech service. Your spoken commands and any page content you allow go to the configured AI service for page understanding.

## Reading and acting

AccessAssist handles ordinary buttons, links, and form fields, plus common custom controls such as time grids built from table cells or from bare, unlabeled cells. A grid of unlabeled cells is read as one grid: each cell gets its column and row from the text drawn above and beside it, even when hour labels appear only every few rows.

### Page consent

Before it first reads page text for a site, AccessAssist lists the current site and every embedded source in one confirmation. If both need permission, "Allow listed sites" allows the whole list and "Current site only" leaves embedded sites unread. A new embedded site gets its own confirmation, and screenshots need separate consent. Following a link or submitting a form on the same site keeps the consent already given; a new site can bring another question.

Until you allow page text for a site, the AI service gets nothing about the page, not its title and not its address. When you decline, AccessAssist remembers it for that site until the conversation resets: it asks nothing more for that request and does not ask again on its own. A later request that explicitly asks to read or look at the page can bring the question back once.

### Tabs

AccessAssist always works on the active tab of the window that owns the panel. When you switch tabs in that window, it follows and says the new page. A tab that is not a web page, such as a new tab page, is reported as unreadable, and the page you left is never read or changed out of sight.

If you switch while an action is waiting for your confirmation, it is not run. An action already running finishes on its page, and the panel then moves to your tab. When the page in the same tab changes, for example after a form is submitted, the conversation continues: a running action still reports its result, and the assistant reads the new page before acting on it.

### Screenshots

A screenshot can guide a click or drag on visual targets such as canvases. Embedded frames and password fields, including fields inside shadow roots, are painted solid black before the screenshot leaves the browser. The AI service is told which areas are hidden, and clicks or drags into them are refused.

A screenshot stays in memory, maps to one observation and viewport position, and expires after a scroll, focus change, action, or navigation.

### Actions and undo

Some custom controls save a change as soon as they are clicked. The panel says whether it saw a change and whether it verified the requested result, asks once before a change it cannot undo, with one summary covering every step of the request, and never claims a color change or server save it could not confirm.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, the live AI check, and packaging.

## Known limits

- OpenCode Go is designed for coding-agent requests. This project's use of the service has not been confirmed by OpenCode.
- The ChatGPT plan option uses OpenAI's Sign in with ChatGPT program for open-source apps, which OpenAI describes as limited to eligible plans. Plan usage stops when you reach your plan's limit (on Plus, the five-hour limit is shared with every app that uses your plan); it never falls back to paid API billing. "ChatGPT usage" in Settings links to your remaining usage. Which reasoning effort levels a model accepts depends on the model; one that refuses a level is reported, and you can choose another.
- Automated tests use a scripted voice and an extension tab. They cannot replace testing with VoiceOver, Narrator, NVDA, or JAWS on Windows and macOS with the real side panel; see [CONTRIBUTING.md](CONTRIBUTING.md) for what they cover.
- The image-exploration keys for each screen reader depend on that reader's version and settings, and Narrator's and JAWS's description features may use online services. AccessAssist cannot enable or configure any of them. The JAWS guide names Picture Smart but gives no keys: Freedom Scientific's documentation could not be checked, so add them only once they are verified.
- Side-panel keyboard focus belongs to Chrome. The panel focuses the current choice, but Chrome builds before 148 may leave browser focus on the page when the shortcut opens the panel; Chrome 148 beta and later reportedly fix that handoff. Until then, use F6/Shift+F6 on Windows or Command+Option+Up/Down on macOS.
- A managed browser policy can block the English speech pack or microphone.
