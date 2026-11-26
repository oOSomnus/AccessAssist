# AccessAssist

AccessAssist is a Chrome side panel for blind users. It reads a page on command, confirms actions with numbered choices, asks before changing anything, and reports what it verified or can undo.

## Install

Requires Chrome 142 or later. No build step and no npm install: `extension/` is the whole extension.

1. Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and select the `extension/` folder.
2. Open a web page and press `Control+Shift+Space` (physical Control on macOS too), or use the toolbar button or the "Assistant" button on the page. This opens or focuses the panel without recording. Drag the Assistant button anywhere in the viewport to move it, or focus it and press Shift+Arrow to nudge it; the position is remembered. After updating the extension, reload already open pages to get the new button.
3. Press `Control+Shift+Y` for one dictated command, or choose Listen. `Control+Shift+Period` closes the panel. Replay introduction has no default key; use the Settings button or assign one at `chrome://extensions/shortcuts`. An existing profile keeps its saved key until you rebind Close panel there once.
4. In Settings, choose a Model service:
   - **OpenCode Go API key**: paste an OpenCode Go API key and save. The panel has a "Get an API key" link. The key lasts for this browser session, and changing the API origin clears it. Advanced API settings also include Reasoning effort. Provider default sends no effort parameter; supported levels depend on the model, and some models map levels to the same behavior.
   - **ChatGPT plan**: choose "Continue with ChatGPT". OpenAI's sign-in opens in a new tab; sign in there, and when you finish the tab closes and you return to your page. Then choose a ChatGPT model (the list shows the models your account can use) and a Reasoning effort, and save. Requests use the usage included in your ChatGPT plan through OpenAI's Sign in with ChatGPT program, not an API key. You stay signed in across browser restarts until you choose "Sign out of ChatGPT". A pasted OpenCode key is kept while the ChatGPT plan is chosen, so you can switch back.

The shortcuts use physical Control, not Command, so they avoid macOS Command+Shift screenshot keys. Distribute them across both sides of the keyboard or use the native buttons and system sticky keys; no timed key sequence is required.

## Voice

Press `Control+Shift+Y` or choose Listen for one command. The system screen reader says "Listening", then two high tones mean the microphone is ready; speak after the second tone. The panel waits up to 15 seconds for you to start and about 2 seconds between phrases, then joins your finalized phrases into one instruction. A 60-second cap keeps a stuck recognizer from holding the microphone. AccessAssist recognizes one isolated microphone track with system echo cancellation and never falls back to a default input; if that isolation is unavailable, it says so and does not record. It reads the recognized words back, then announces that it is working before the task starts. It listens only for that request: answers, pauses, the main open shortcut, and panel button taps do not reopen the microphone. Recognized speech is used automatically after the readback; there is no extra Send step.

The first Listen or Prepare voice downloads Chrome's English speech pack and asks for microphone access. If you dismissed the prompt or Chrome blocked it, choose Prepare voice or Retry. If the side panel cannot show the prompt, it opens a setup tab once; finish Prepare voice there, then choose Return to assistant. Voice is the only input; the panel has no text box.

### Speech output

AccessAssist always uses the system screen reader: every status, readback, question, and answer goes to one live region, and VoiceOver, Narrator, NVDA, or JAWS speaks it. There is no extension voice or output selector. A live region confirms delivery to the page, not that a screen reader finished speaking. The panel takes keyboard focus as it opens, and loads hidden from screen readers (not from view), so a reader that reads a freshly loaded page aloud, such as VoiceOver with "speak web page" on, has nothing to read. Once the panel knows why it opened, it exposes Listen and puts focus there, so a screen reader names that button instead of reading the whole panel; the rest appears to the reader on your first key press, click, or focus move, or about a second and a half later. The listen shortcut is different: when it opens the panel, the panel stays hidden from screen readers while you dictate, so as long as it stays hidden you hear "Listening." and the tone and nothing else. It appears when listening ends, or sooner on a key press, click, or focus move in the panel, or after 30 seconds if listening never reports an end. When it appears, focus goes to Listen unless a panel control already has it.

One region, written one message at a time, is deliberate. The panel queues its messages and holds each one for an estimate of how long a reader needs, capped at six seconds, so the order you hear is the order the panel intended rather than one each screen reader resolves for itself. A message that matters more, such as losing microphone permission, drops the status messages still waiting and goes next, ahead of an open question, which stays queued until it is answered or closed. It waits only for the current estimated hold to end; the panel cannot tell when the reader actually finishes, so a long message may still be being read when it arrives. Each message is announced once and then cleared, so the region does not become a second, stale copy of the conversation to wander into; the transcript keeps the durable copy. Press `Control` on its own to stop speech already being read — that works in all four readers, and AccessAssist never binds `Control` by itself.

The working pattern plays while a request runs and stays quiet while a message is still being read. Each numbered choice is named before its source sites. Choice numbers use `Control+Shift+1` through `Control+Shift+9`; plain digits stay with your screen reader. They work wherever focus is in the panel: a number the focused group does not use goes to the visible control that shows it, and a number nothing uses is answered with "Nothing uses Control plus Shift plus 9 right now." While a question is open, its numbers also answer it from the page in front, because keyboard focus is often there; only those numbers, only while the question is open, and only real key presses are caught, so the page keeps every other key. `Control+Shift+Space` never presses the panel control that has focus. The choice keys are not read out with every question — they are in the introduction, in Settings, and on screen. Pressing `Control+Shift+Space` asks the panel to take keyboard focus and focuses the current choice, or the Listen button when there is no question. Chrome can still keep native side-panel focus on the page in some versions; then use F6/Shift+F6 on Windows or Command+Option+Up/Down on macOS to reach the assistant, then Tab.

### Which screen reader you use

Settings has a Screen reader choice. It affects only the keys AccessAssist reads out when you want to explore an image with your own reader, and it covers Narrator, NVDA, JAWS, and VoiceOver. A web page cannot detect a screen reader, only the operating system, so leaving it on "Detect from this system" means a Windows profile is asked once which reader it runs and the answer is remembered.

### Local speech versus the AI service

Speech recognition runs on this device. The speech pack download needs a network connection, and recognition does not fall back to Google's online speech service. Your spoken commands and any page content you allow go to the configured AI service for page understanding.

## Reading and acting

AccessAssist handles ordinary buttons, links, and form fields, plus common custom controls such as time grids built from table cells or from bare, unlabeled cells. A grid of unlabeled cells is read as one grid: each cell gets its column and row from the text drawn above and beside it, even when hour labels appear only every few rows. Before it reads page text, it lists the current site and every embedded source in one confirmation. "Allow listed sites" reads that whole snapshot; "Current site only" leaves embedded sites unread. A source that appears later gets its own confirmation. Screenshots need their own consent. Moving to another page on the same site keeps the consent already given; a new site, or an embedded source not listed before, can bring another question.

Until you allow page text for a site, the AI service gets nothing about the page — not its title and not its address. When you decline, AccessAssist remembers it for that site until the conversation resets: it asks nothing more for that request and does not ask again on its own. A later request that explicitly asks to read or look at the page can bring the question back once.

AccessAssist always works on the tab in front of you. When you switch tabs, it follows and says the new page; a tab that is not a web page, such as a new tab page, is reported as unreadable, and the page you left is never read or changed out of sight. If you switch while an action is waiting for your confirmation, it is not run; an action already running finishes on its page, and the panel then moves to your tab. When the page in the same tab changes, for example after a form is submitted, the conversation continues: a running action still reports its result, and the assistant reads the new page before acting on it.

A screenshot can guide a click or drag on visual targets such as canvases. Embedded frames and password fields, including fields inside shadow roots, are painted solid black before the screenshot leaves the browser; the AI service is told which areas are hidden, and clicks inside them are refused. A screenshot stays in memory, maps to one observation and viewport position, and expires when the page scrolls or navigates.

Some custom controls save a change as soon as they are clicked. The panel says whether it saw a change and whether it verified the requested result, asks once before an action it cannot undo, with one summary covering every step of the request, and never claims a color change or server save it could not confirm.

### Signing in with ChatGPT

The sign-in tab belongs to OpenAI. AccessAssist never reads, captures, or operates that tab, even though it is a normal web page, and it never sees your password. When the tab returns to AccessAssist, the extension exchanges the one-time code for tokens and closes the tab. The long-lived sign-in is kept in the browser profile, readable only by the extension. The short-lived access token is kept only for this browser session. "Sign out of ChatGPT" deletes both and asks OpenAI to end the sign-in.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, the live AI check, and packaging.

## Known limits

- OpenCode Go is designed for coding-agent requests. This project's use of the service has not been confirmed by OpenCode.
- The ChatGPT plan option uses OpenAI's Sign in with ChatGPT program for open-source apps, which OpenAI describes as limited to eligible plans. Plan usage stops when you reach your plan's limit (on Plus, the five-hour limit is shared with every app that uses your plan); it never falls back to paid API billing. "ChatGPT usage" in Settings links to your remaining usage. Which reasoning effort levels a model accepts depends on the model; one that refuses a level is reported, and you can choose another.
- The ChatGPT sign-in returns to `http://127.0.0.1:1455/auth/callback`. AccessAssist reads the code from the navigation itself; nothing needs to listen on that port.
- Automated tests use a scripted voice and an extension tab; they cannot prove OS shortcut registration, native side-panel focus or closure, audible speech, or real screen-reader behavior. They check that the panel delivers messages in the intended order, not that a reader speaks them that way. Check VoiceOver, Narrator, NVDA, and JAWS on Windows and macOS with the actual side panel.
- The hold between announcements is an estimate from message length, not a signal from the screen reader; no such signal exists for a web page. A reader set to a slow rate can still be speaking when the next message arrives.
- The image-exploration keys for each screen reader depend on that reader's version and settings, and Narrator's and JAWS's description features may use online services. AccessAssist cannot enable or configure any of them. The JAWS guide names Picture Smart but gives no keys: Freedom Scientific's documentation could not be checked, so add them only once they are verified.
- Side-panel keyboard focus belongs to Chrome. The panel focuses the current choice, but Chrome builds before 148 may leave browser focus on the page when the shortcut opens the panel; Chrome 148 beta and later reportedly fix that handoff. Until then, use F6/Shift+F6 on Windows or Command+Option+Up/Down on macOS.
- A managed browser policy can block the English speech pack or microphone.
