// Speech output and recognition. Pure helpers are exported for unit tests; the
// class touches Chrome APIs only when its methods run.
export const SOUND_CUES = Object.freeze({
  typing: [[660, 80], [440, 80]],
  choose: [[660, 80]],
  cancel: [[440, 80], [220, 120]],
  fail: [[220, 80], [220, 80]],
  listening: [[880, 180], [880, 180]],
  working: [[440, 50], [550, 50]],
});

const START_TIMEOUT_MS = 10_000;
const INITIAL_SPEECH_TIMEOUT_MS = 15_000;
const SPEECH_PAUSE_MS = 2_000;
const COMMAND_TIMEOUT_MS = 60_000;
const RECOGNITION_RESTART_MS = 250;
const ABORT_TIMEOUT_MS = 2_000;
const RESUME_TIMEOUT_MS = 2_000;
const CUE_GRACE_MS = 2_000;
const CUE_GAP_MS = 80;
const CUE_GAIN = 0.15;
const LISTENING_GAIN = 0.25;
const WORKING_GAIN = 0.035;
const WORKING_DELAY_MS = 400;
const WORKING_GAP_MS = 1200;
const WORKING_FAILURES = 3;
// A live region reports delivery to the page, never that a screen reader
// finished speaking. These bounds estimate how long one message occupies the
// reader at roughly 180 words per minute, so the queue leaves a gap between
// messages and the working tone stays out of the way. The cap is deliberately
// short: a long answer must not stall the queue behind it.
const SPEECH_MS_PER_WORD = 330;
const SPEECH_SETUP_MS = 400;
const SPEECH_HOLD_MIN_MS = 1_200;
const SPEECH_HOLD_MAX_MS = 6_000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The results a native result event changed, for the debug log.
function resultSummary(event) {
  const results = event?.results;
  if (!results) return [];
  const out = [];
  for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
    const result = results[index];
    out.push({ index, final: Boolean(result?.isFinal), text: result?.[0]?.transcript ?? '' });
  }
  return out;
}

// Tests shorten the hold so a queued sequence fits inside their poll budget.
function speechHoldMs(text) {
  const override = globalThis.__aaSpeechHoldMs;
  if (Number.isFinite(override)) return Math.max(0, override);
  const words = String(text).trim().split(/\s+/u).filter(Boolean).length;
  return clamp(words * SPEECH_MS_PER_WORD + SPEECH_SETUP_MS, SPEECH_HOLD_MIN_MS, SPEECH_HOLD_MAX_MS);
}
// Chrome only honors the track overload on these platforms; elsewhere the
// extra argument can be dropped and the default microphone used instead.
const ISOLATED_INPUT_OS = new Set(['win', 'mac', 'linux']);
const ISOLATION_UNAVAILABLE = 'System audio cancellation is unavailable for this recording. Speech did not start.';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function speechError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function releaseStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    try { track.stop(); } catch {}
  }
}

function captureError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return speechError('not-allowed', 'Microphone permission was denied.');
  }
  if (error?.name === 'OverconstrainedError') {
    return speechError('audio-capture', ISOLATION_UNAVAILABLE);
  }
  return speechError('mic', `Cannot use the microphone: ${error?.message ?? 'no input device was found'}`);
}

// Speech-only shortening. Callers keep the real origins for consent, storage,
// and requests. Every HTTPS site is spoken as its host without a leading www;
// other schemes and unparseable values stay unchanged.
export function spokenSites(origins) {
  if (!Array.isArray(origins)) return [];
  return origins.map((origin) => {
    if (typeof origin !== 'string') return origin;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return origin;
    }
    if (url.protocol !== 'https:') return origin;
    return url.host.startsWith('www.') ? url.host.slice(4) : url.host;
  });
}

export function localRecognitionSupported(Recognition) {
  return typeof Recognition?.available === 'function';
}

// The voice-setup section for one surface: which controls show and the one status sentence.
export function voiceSetupView({ surface, local, mic, ready, preparing, failed, listen }) {
  const retry = !ready && (failed || mic === 'denied' || local === 'unavailable' || local === 'error');
  // In the panel the composer's Listen button already reads "1 Prepare voice"
  // while voice is unready, so this one must not answer to the same name.
  const startLabel = retry ? '1 Retry' : surface === 'setup' ? '1 Prepare voice' : '1 Set up voice';
  if (surface === 'setup') {
    // Keep the preparation entry visible whenever it is not already running,
    // so a first-time user can start the pack download without a shortcut.
    const status = ready ? 'Microphone access is granted. Speech is ready on this device.'
      : local === 'unavailable' ? 'This Chrome cannot recognize speech on this device.'
        : local === 'error' ? 'Chrome could not check the English speech pack. Choose Retry.'
          : mic === 'denied' ? 'Microphone access is denied. Allow it in Chrome site settings and system settings, then choose Retry.'
            : preparing ? 'Chrome is preparing the English speech pack and will ask for the microphone. Allow it when Chrome asks.'
              : local === 'downloading' ? 'Chrome is downloading the English speech pack. Voice will be ready when it finishes.'
                // A failed attempt shows Retry, so the text must name Retry too.
                : retry ? 'Voice is not ready. Choose Retry to try again.'
                  : local === 'downloadable' ? 'Chrome needs the English speech pack. Choose Prepare voice to start.'
                    : mic === 'granted' ? 'Waiting for the English speech pack.'
                      : 'Press Prepare voice to check the microphone and prepare speech.';
    return { sectionHidden: false, returnHidden: !ready, startHidden: ready || preparing || local === 'downloading', startLabel, status };
  }
  if (ready) return { sectionHidden: true };
  const status = local === 'unavailable' ? 'This Chrome cannot recognize speech on this device. Choose Retry after enabling local speech.'
    : local === 'error' ? 'Chrome could not check the English speech pack. Choose Retry.'
      : mic === 'denied' ? 'Microphone access is denied. Allow it in Chrome site settings and system settings, then choose Retry.'
        : preparing ? 'Chrome is preparing the English speech pack and will ask for the microphone.'
          : local === 'downloading' ? 'Chrome is downloading the English speech pack. Voice will be ready when it finishes.'
            : retry ? 'Voice is not ready. Choose Retry to try again.'
              : local === 'downloadable' ? 'The English speech pack is not ready. Choose Set up voice to start.'
                : mic === 'granted' ? `Speech is ready. ${listen}.`
                  : 'Voice needs microphone permission. Choose Set up voice to start.';
  return { sectionHidden: false, returnHidden: true, startHidden: (preparing || local === 'downloading') && !retry, startLabel, status };
}

export class Speech {
  constructor({ lang = 'en-US' } = {}) {
    this.lang = lang;
    this.liveEl = null;
    this.queue = [];
    this.queueTimer = null;
    this.shown = null;
    this.quietUntil = 0;
    this.audio = null;
    this.listening = false;
    this.sessionSeq = 0;
    this.session = null;
    this.inputGeneration = 0;
    this.localAvailable = false;
    this.localStatus = null;
    this.installAttempt = null;
    this.microphonePromise = null;
    this.cueToken = 0;
    this.cueName = null;
    this.cuePromise = null;
    this.cueFinish = null;
    this.cueInterrupted = false;
    this.workingActive = false;
    this.workingTimer = null;
    this.workingToken = 0;
    this.workingNodes = null;
    this.workingFailures = 0;
    this.onWrite = null;
    this.onEvent = null;
  }

  attach({ liveEl, onWrite = null, onEvent = null }) {
    this.liveEl = liveEl;
    this.onWrite = onWrite;
    this.onEvent = onEvent;
  }

  // Native recognizer and microphone events, for the exported debug log only.
  // They show where a command was lost between the ready tones and a result.
  trace(session, kind, data = {}) {
    try {
      this.onEvent?.(kind, { session: session?.id ?? null, ...data });
    } catch {}
  }

  async resumeAudio() {
    try {
      if (!this.audio) this.audio = new AudioContext();
      if (this.audio.state === 'suspended') {
        await Promise.race([this.audio.resume(), wait(RESUME_TIMEOUT_MS)]);
      }
      return this.audio.state === 'running';
    } catch {
      this.audio = null;
      return false;
    }
  }

  // Resolves true only after the last tone has actually ended.
  async play(name) {
    const cue = SOUND_CUES[name];
    if (!cue) return false;
    this.cancelCue();
    this.cueInterrupted = false;
    const token = ++this.cueToken;
    this.cueName = name;
    const running = await this.resumeAudio();
    if (token !== this.cueToken) return false;
    if (!running || !this.audio) {
      this.cueName = null;
      return false;
    }
    const nodes = [];
    let released = false;
    // Cue-local teardown: stop and disconnect this cue's nodes exactly once.
    const release = (stop) => {
      if (released) return;
      released = true;
      for (const { oscillator, gain } of nodes) {
        if (stop) {
          try { oscillator.stop(); } catch {}
        }
        try { oscillator.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      }
    };
    let resolveCue;
    const finished = new Promise((resolve) => { resolveCue = resolve; });
    const finish = (value = false) => {
      if (this.cuePromise !== finished) return;
      this.cuePromise = null;
      this.cueFinish = null;
      this.cueName = null;
      resolveCue(value);
    };
    const stopCue = () => {
      release(true);
      finish(false);
    };
    this.cuePromise = finished;
    this.cueFinish = stopCue;
    try {
      const start = this.audio.currentTime + 0.01;
      const gainValue = name === 'listening' ? LISTENING_GAIN : CUE_GAIN;
      let offset = 0;
      for (const [index, [frequency, duration]] of cue.entries()) {
        const oscillator = this.audio.createOscillator();
        const gain = this.audio.createGain();
        nodes.push({ oscillator, gain });
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(gainValue, start + offset + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration / 1000);
        oscillator.connect(gain).connect(this.audio.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration / 1000);
        offset += duration / 1000;
        if (index < cue.length - 1) offset += CUE_GAP_MS / 1000;
      }
      nodes.at(-1).oscillator.onended = () => {
        release(false);
        finish(true);
      };
      const tones = cue.reduce((sum, [, duration]) => sum + duration, 0);
      const totalMs = tones + CUE_GAP_MS * (cue.length - 1);
      const timer = setTimeout(stopCue, totalMs + CUE_GRACE_MS);
      const result = await finished;
      clearTimeout(timer);
      return result === true && token === this.cueToken;
    } catch {
      stopCue();
      return false;
    }
  }

  cancelCue() {
    // A user action that replaces a playing cue is not an audio failure.
    this.cueInterrupted = Boolean(this.cuePromise);
    this.cueToken += 1;
    const stopCue = this.cueFinish;
    this.cueFinish = null;
    this.cueName = null;
    stopCue?.();
  }

  // One timer per cycle; idempotent so callers can sync on every state change.
  setWorking(active) {
    if (active !== true) {
      this.stopWorking();
      return;
    }
    if (this.workingActive) return;
    this.workingActive = true;
    this.workingFailures = 0;
    this.workingToken += 1;
    this.scheduleWorking(WORKING_DELAY_MS);
  }

  stopWorking() {
    this.workingActive = false;
    this.workingToken += 1;
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.workingTimer = null;
    for (const oscillator of this.workingNodes ?? []) {
      try { oscillator.stop(); } catch {}
    }
    this.workingNodes = null;
  }

  // Cuts the tone group that is sounding now but keeps the working request,
  // so the next group still plays once the region is quiet again.
  silenceWorking() {
    for (const oscillator of this.workingNodes ?? []) {
      try { oscillator.stop(); } catch {}
    }
    this.workingNodes = null;
  }

  scheduleWorking(delay) {
    if (!this.workingActive || this.workingTimer) return;
    const token = this.workingToken;
    // A tone over a screen reader buries the message. While a message still
    // holds the region, wait out the rest of its hold instead of playing.
    const quiet = this.quietUntil - Date.now();
    const wait = quiet > 0 ? Math.max(delay, quiet) : delay;
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      if (this.quietUntil - Date.now() > 0) {
        this.scheduleWorking(WORKING_GAP_MS);
        return;
      }
      void this.playWorkingGroup(token);
    }, wait);
  }

  async playWorkingGroup(token) {
    if (!this.workingActive || token !== this.workingToken) return;
    // Listening and earcons win; retry after the gap.
    if (this.listening || this.cuePromise) {
      this.scheduleWorking(WORKING_GAP_MS);
      return;
    }
    const running = await this.resumeAudio();
    if (!this.workingActive || token !== this.workingToken) return;
    // A message may have entered the region while audio was resuming.
    if (this.quietUntil - Date.now() > 0) {
      this.scheduleWorking(WORKING_GAP_MS);
      return;
    }
    if (!running || !this.audio) {
      this.workingFailures += 1;
      if (this.workingFailures >= WORKING_FAILURES) {
        this.stopWorking();
        this.writeStatus('The working sound could not play. Spoken controls still work.');
        return;
      }
      this.scheduleWorking(WORKING_GAP_MS);
      return;
    }
    try {
      const start = this.audio.currentTime + 0.01;
      let offset = 0;
      const nodes = [];
      for (const [frequency, duration] of SOUND_CUES.working) {
        const oscillator = this.audio.createOscillator();
        const gain = this.audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(WORKING_GAIN, start + offset + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration / 1000);
        oscillator.connect(gain).connect(this.audio.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration / 1000);
        nodes.push(oscillator);
        offset += duration / 1000;
      }
      this.workingNodes = nodes;
      this.workingFailures = 0;
      this.scheduleWorking(offset * 1000 + WORKING_GAP_MS);
    } catch {
      this.scheduleWorking(WORKING_GAP_MS);
    }
  }

  // One region, one queue. Both readers then speak the same messages in the
  // same order: an urgent message goes ahead of what is still pending rather
  // than racing a second region whose priority each reader resolves
  // differently. Returns whether the message was accepted, which is delivery
  // to the page and never proof that a reader spoke it.
  // A tag names what a message is about, so the message can be withdrawn while
  // it is still waiting once that thing is gone; see dropPending.
  writeStatus(text, urgent = false, tag = null) {
    return this.enqueue(text, { urgent, tag }) !== null;
  }

  // Queues one message and returns a promise that settles once: delivered
  // when the message is written to the region, not delivered when it is
  // withdrawn first. Returns null when there is no region to write to.
  enqueue(text, { urgent = false, tag = null } = {}) {
    const target = this.liveEl;
    if (!target || target.isConnected === false) return null;
    const value = String(text);
    this.onWrite?.(value, urgent);
    let settle;
    const written = new Promise((resolve) => { settle = resolve; });
    const entry = { value, urgent, tag, settle };
    if (urgent) {
      // An untagged pending message describes a state this one supersedes.
      // A tagged one is about something its owner still holds open, such as
      // an unanswered question, so it waits behind the urgent message instead
      // and is withdrawn only when that thing closes.
      const kept = [];
      for (const pending of this.queue) {
        if (pending.urgent || pending.tag != null) kept.push(pending);
        else pending.settle(false);
      }
      // Behind earlier urgent messages, ahead of everything else, so urgent
      // messages keep the order they were raised in.
      const at = kept.findIndex((pending) => !pending.urgent);
      if (at === -1) kept.push(entry);
      else kept.splice(at, 0, entry);
      this.queue = kept;
    } else {
      this.queue.push(entry);
    }
    this.pumpQueue();
    return written;
  }

  // Withdraws messages with this tag that have not been written yet. A
  // question answered or replaced while its reading still waits in the queue
  // must not be read out afterwards. The message already in the region is left
  // alone: it may be mid-sentence, and cutting it off is the reader's job.
  dropPending(tag) {
    if (tag == null) return;
    this.queue = this.queue.filter((entry) => {
      if (entry.tag !== tag) return true;
      entry.settle(false);
      return false;
    });
  }

  // Ends the hold of the message in the region when it carries this tag. A
  // question that was just answered has nothing left to say, and its remaining
  // hold only delays the confirmation queued behind it: the Control chord that
  // answered it already stopped the reader, so the user would hear up to six
  // seconds of silence. Clearing the region is silent; a reading still in
  // progress stays the reader's to finish.
  releaseShown(tag) {
    if (tag == null || this.shown?.tag !== tag) return;
    clearTimeout(this.queueTimer);
    this.queueTimer = null;
    this.shown = null;
    this.quietUntil = 0;
    this.clearLive();
    this.pumpQueue();
  }

  // Writes one message, then holds the region for an estimate of how long a
  // reader needs for it. The hold is capped at six seconds and nothing reports
  // when reading actually finishes, so a later message, urgent or not, waits
  // only for the current estimated hold. This queue is what keeps a later
  // message from overwriting one that was just written, so the region itself
  // can stay atomic and ephemeral.
  pumpQueue() {
    if (this.queueTimer) return;
    const entry = this.queue.shift();
    if (!entry) return;
    const target = this.liveEl;
    if (!target || target.isConnected === false) {
      entry.settle(false);
      for (const pending of this.queue) pending.settle(false);
      this.queue.length = 0;
      return;
    }
    // A tone over a screen reader buries the message.
    this.silenceWorking();
    this.showMessage(target, entry.value);
    this.shown = entry;
    entry.settle(true);
    const hold = speechHoldMs(entry.value);
    this.quietUntil = Date.now() + hold;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.shown = null;
      // Clearing stops the hidden region from becoming a browsable copy of the
      // transcript; aria-relevant="additions" keeps the removal silent.
      this.clearLive();
      this.pumpQueue();
    }, hold);
  }

  // One mutation per message: an empty-then-fill write makes some readers
  // announce the same message twice.
  showMessage(target, value) {
    const owner = target.ownerDocument;
    if (owner?.createElement && target.replaceChildren) {
      const message = owner.createElement('div');
      message.textContent = value;
      target.replaceChildren(message);
      return;
    }
    target.textContent = value;
  }

  clearLive() {
    const target = this.liveEl;
    if (!target) return;
    if (target.replaceChildren) target.replaceChildren();
    else target.textContent = '';
  }

  // Drops every message not yet written. Only a user action reaches this, so it
  // also releases the quiet window and lets the working tone resume. Messages
  // whose tag is in keep survive: their subject is still open. A kept message
  // already in the region also keeps its hold, so it is not cut short.
  cancelQueue({ keep = [] } = {}) {
    const kept = new Set(keep.filter((tag) => tag != null));
    this.queue = this.queue.filter((entry) => {
      if (kept.has(entry.tag)) return true;
      entry.settle(false);
      return false;
    });
    if (this.shown && kept.has(this.shown.tag)) return;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    this.shown = null;
    this.quietUntil = 0;
    this.clearLive();
    this.pumpQueue();
  }

  clearStatus() {
    this.cancelQueue();
  }

  // Stopping recording here keeps a readback from being captured as a new
  // command. Settles once the message is written to the region (delivered) or
  // withdrawn before that (not delivered). Written is not spoken: nothing
  // reports when a reader finishes.
  async announce(text, { urgent = false, tag = null } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return { delivered: true, interrupted: false, reason: null };
    this.stopListening();
    const written = this.enqueue(value, { urgent, tag });
    if (!written) return { delivered: false, interrupted: false, reason: 'no-region' };
    const delivered = await written;
    return {
      delivered,
      interrupted: false,
      reason: delivered ? null : 'withdrawn',
    };
  }

  recognitionClass() {
    const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    if (!Recognition) throw speechError('unsupported', 'This browser does not support speech recognition');
    return Recognition;
  }

  ensureRecognition() {
    const Recognition = this.recognitionClass();
    if (!this.recognition) {
      const recognition = new Recognition();
      recognition.lang = this.lang;
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 1;
      this.recognition = recognition;
    }
    return this.recognition;
  }

  async getLocalRecognitionStatus() {
    let Recognition;
    try {
      Recognition = this.recognitionClass();
    } catch {
      return 'unavailable';
    }
    if (!localRecognitionSupported(Recognition)) return 'unavailable';
    let recognition;
    try {
      recognition = this.ensureRecognition();
    } catch {
      return 'unavailable';
    }
    if (!('processLocally' in recognition)) return 'unavailable';
    try {
      const status = await Recognition.available({ langs: [this.lang], processLocally: true });
      return ['available', 'downloadable', 'downloading', 'unavailable'].includes(status) ? status : 'error';
    } catch {
      return 'error';
    }
  }

  async refreshLocalStatus() {
    this.localStatus = await this.getLocalRecognitionStatus();
    this.localAvailable = this.localStatus === 'available';
    return this.localStatus;
  }

  // Starts one install attempt and returns its promise. The install call stays
  // before every await so a caller that still holds activation can use it; a
  // refusal is recoverable rather than permanent. Callers must not treat this
  // promise as readiness because it can stay pending while Chrome downloads.
  startLocalRecognitionInstall({ force = false, onProgress } = {}) {
    if (this.localAvailable) return Promise.resolve(true);
    if (this.installAttempt && (!force || this.localStatus === 'downloading')) return this.installAttempt;
    if (this.localStatus === 'downloading' && !force) {
      // Chrome is already downloading; observe availability instead of asking
      // for another download. A real Retry button passes force.
      return new Promise(() => {});
    }
    let Recognition;
    try {
      Recognition = this.recognitionClass();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!localRecognitionSupported(Recognition)) {
      return Promise.reject(speechError('unsupported', 'This Chrome does not support local speech recognition.'));
    }
    let recognition;
    try {
      recognition = this.ensureRecognition();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!('processLocally' in recognition)) {
      return Promise.reject(speechError('unsupported', 'This Chrome does not support local speech recognition.'));
    }
    onProgress?.('Preparing the English speech pack.');
    let install;
    try {
      install = Recognition.install({ langs: [this.lang], processLocally: true });
    } catch (error) {
      return Promise.reject(speechError('install', `Chrome could not prepare the English speech pack: ${error?.message ?? 'download failed'}`));
    }
    const attempt = (async () => {
      try {
        const accepted = await install;
        if (accepted === true) {
          const status = await this.getLocalRecognitionStatus();
          if (status === 'available') {
            this.localAvailable = true;
            this.localStatus = 'available';
          }
        }
        return accepted;
      } finally {
        if (this.installAttempt === attempt) this.installAttempt = null;
      }
    })();
    this.installAttempt = attempt;
    return attempt;
  }

  waitOrAbort(ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // Watches the real availability state instead of the install promise. Slow
  // downloads keep polling rather than becoming a failure.
  async waitForLocalRecognition({
    onStatus,
    onSlow,
    signal,
    intervalMs = 1000,
    slowAfterMs = 120_000,
    slowIntervalMs = 5000,
  } = {}) {
    if (this.localAvailable) {
      onStatus?.('available');
      return 'available';
    }
    const started = Date.now();
    let last = null;
    let announcedSlow = false;
    while (true) {
      if (signal?.aborted) return 'aborted';
      const status = await this.refreshLocalStatus();
      if (signal?.aborted) return 'aborted';
      if (status !== last) {
        last = status;
        onStatus?.(status);
      }
      if (status === 'available' || status === 'unavailable') return status;
      const elapsed = Date.now() - started;
      if (!announcedSlow && elapsed >= slowAfterMs) {
        announcedSlow = true;
        onSlow?.();
      }
      await this.waitOrAbort(elapsed >= slowAfterMs ? slowIntervalMs : intervalMs, signal);
    }
  }

  createNativeRecognition() {
    // Every native attempt owns a fresh recognizer. A previous attempt that
    // lost its end event can never receive results for the next one.
    this.recognition = null;
    const recognition = this.ensureRecognition();
    if (!('processLocally' in recognition)) {
      throw speechError('unsupported', 'This Chrome does not support local speech recognition.');
    }
    try {
      recognition.processLocally = true;
    } catch {}
    if (recognition.processLocally !== true) {
      throw speechError('local', 'Chrome refused to keep speech recognition on this device.');
    }
    return recognition;
  }

  async ensureRecognitionReady() {
    if (!this.localAvailable) await this.refreshLocalStatus();
    if (!this.localAvailable) {
      throw speechError('unavailable', 'The English speech pack is still being prepared. Try again in a moment.');
    }
    return this.createNativeRecognition();
  }

  current(session) {
    return this.session === session && !session.ended && !session.cancelled
      && !session.failure && !session.finalDelivered && !session.terminal;
  }

  startListening({ onResult, onError, onReady, onEnd } = {}) {
    return this.commandSession({ onResult, onError, onReady, onEnd });
  }

  // Re-reads this.session after every wait, so a second request that the same
  // native end wakes up joins the newly opened session instead of starting one.
  async commandSession(handlers) {
    const active = this.session;
    if (!active || active.ended) return this.openSession(handlers);
    if (active.cancelled || active.failure) return this.restartAfter(active, handlers);
    if (!active.finalDelivered) return active.ready;
    this.stopListening();
    return this.restartAfter(active, handlers);
  }

  cancelOutcome(session) {
    session.ready.catch(() => {});
    return { ready: false, cancelled: true, sessionId: session.id };
  }

  // A missing native end after a bounded wait abandons the old recognizer
  // instead of locking the extension until a reload.
  async awaitEnd(previous) {
    if (previous.ended) return;
    const outcome = await Promise.race([
      previous.endedPromise.then(() => 'ended'),
      wait(ABORT_TIMEOUT_MS).then(() => 'timeout'),
    ]);
    if (outcome === 'ended' || previous.ended) return;
    try { previous.recognition?.abort(); } catch {}
    this.finishSession(previous, 'timeout');
  }

  // Waits for the previous native session to release the recognizer before
  // binding new handlers. Cancels a wait that a newer stop revoked.
  async restartAfter(previous, handlers) {
    const generation = this.inputGeneration;
    await this.awaitEnd(previous);
    if (generation !== this.inputGeneration) return this.cancelOutcome(previous);
    return this.commandSession(handlers);
  }

  openSession(handlers) {
    const session = {
      id: ++this.sessionSeq,
      handlers,
      cancelled: false,
      closing: false,
      ended: false,
      settled: false,
      startRequested: false,
      started: false,
      readyDelivered: false,
      finalDelivered: false,
      failure: null,
      reason: null,
      recognition: null,
      stream: null,
      track: null,
      startTimer: null,
      endTimer: null,
      readyCueToken: null,
      attempt: null,
      preparedRecognition: null,
      finishing: false,
      terminal: false,
      segments: [],
      initialTimer: null,
      pauseTimer: null,
      commandTimer: null,
      restartTimer: null,
      initialDeadline: 0,
      commandDeadline: 0,
      pauseDeadline: 0,
      deadlinesStarted: false,
      hasSpeech: false,
      speechActive: false,
      restartPending: false,
      errorDelivered: false,
    };
    session.endedPromise = new Promise((resolve) => { session.resolveEnd = resolve; });
    session.ready = new Promise((resolve, reject) => {
      session.settle = (value) => {
        if (session.settled) return;
        session.settled = true;
        if (value?.error) reject(value.error);
        else resolve(value);
      };
    });
    this.session = session;
    void this.runSession(session);
    return session.ready;
  }

  async runSession(session) {
    let platform = null;
    try {
      platform = (await chrome.runtime.getPlatformInfo())?.os ?? null;
    } catch {}
    if (!this.current(session)) {
      this.finishSession(session, 'cancelled');
      return;
    }
    if (!ISOLATED_INPUT_OS.has(platform)) {
      this.failSession(session, speechError(
        'unsupported-input',
        'This system cannot isolate the microphone for local recognition.',
      ));
      return;
    }
    try {
      session.preparedRecognition = await this.ensureRecognitionReady();
    } catch (error) {
      this.failSession(session, error);
      return;
    }
    if (!this.current(session)) {
      this.finishSession(session, 'cancelled');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: { exact: 'all' } },
      });
    } catch (error) {
      if (!this.current(session)) {
        this.finishSession(session, 'cancelled');
        return;
      }
      this.failSession(session, captureError(error));
      return;
    }
    // A stream that arrives after a cancel still owns live tracks.
    if (!this.current(session)) {
      releaseStream(stream);
      this.finishSession(session, 'cancelled');
      return;
    }
    session.stream = stream;
    session.track = stream?.getAudioTracks?.()[0] ?? null;
    const track = session.track;
    if (!track || track.kind !== 'audio' || track.readyState !== 'live') {
      this.releaseInput(session);
      this.failSession(session, speechError('audio-capture', ISOLATION_UNAVAILABLE));
      return;
    }
    if (track.getSettings?.().echoCancellation !== 'all') {
      this.releaseInput(session);
      this.failSession(session, speechError('audio-capture', ISOLATION_UNAVAILABLE));
      return;
    }
    track.onended = () => {
      if (!this.current(session)) return;
      this.failSession(session, speechError('audio-capture', 'The microphone stopped. Choose Listen to try again.'));
    };
    this.startAttempt(session);
  }

  startAttempt(session) {
    if (!this.current(session) || session.finishing) return;
    const track = session.track;
    if (!track || track.kind !== 'audio' || track.readyState !== 'live') {
      this.failSession(session, speechError('audio-capture', ISOLATION_UNAVAILABLE));
      return;
    }
    let recognition;
    try {
      recognition = session.preparedRecognition ?? this.createNativeRecognition();
      session.preparedRecognition = null;
    } catch (error) {
      this.failSession(session, error);
      return;
    }
    const attempt = {
      recognition,
      started: false,
      retired: false,
      ignoredFloor: 0,
      finals: new Map(),
      interims: new Map(),
      startTimer: null,
      endTimer: null,
      flushed: false,
    };
    session.recognition = recognition;
    session.attempt = attempt;
    attempt.number = (session.attempts = (session.attempts ?? 0) + 1);
    const trace = (kind, data = {}) => this.trace(session, kind, { attempt: attempt.number, ...data });
    trace('recognizer.request');
    // Set before the native call: a throwing start() can still leave the
    // recognizer active, so the session must also release through onend.
    session.startRequested = true;
    recognition.onstart = () => { trace('recognizer.start'); void this.handleStart(session, attempt); };
    recognition.onresult = (event) => {
      trace('recognizer.result', { ready: Boolean(session.readyDelivered), results: resultSummary(event) });
      this.handleResult(session, attempt, event);
    };
    recognition.onerror = (event) => { trace('recognizer.error', { error: event?.error ?? null }); this.handleError(session, attempt, event); };
    recognition.onspeechstart = () => { trace('recognizer.speechstart'); this.handleSpeech(session, attempt, true); };
    recognition.onspeechend = () => { trace('recognizer.speechend'); this.handleSpeech(session, attempt, false); };
    recognition.onend = () => { trace('recognizer.end'); this.handleEnd(session, attempt); };
    attempt.startTimer = setTimeout(() => {
      if (!this.current(session) || session.attempt !== attempt || attempt.started || attempt.retired) return;
      this.failSession(session, speechError('start-timeout', 'Chrome did not start listening. Choose Listen to try again.'));
    }, START_TIMEOUT_MS);
    try {
      recognition.start(track);
    } catch (error) {
      this.failSession(session, speechError('start', `Could not start recognition: ${error?.message ?? 'try again'}`));
    }
  }

  async handleStart(session, attempt) {
    if (!this.current(session) || session.attempt !== attempt || attempt.retired) {
      // An abort issued while start was in flight may not have taken effect;
      // release this old recognizer again without touching a newer session.
      try { attempt.recognition.abort(); } catch {}
      return;
    }
    if (attempt.started) return;
    clearTimeout(attempt.startTimer);
    attempt.startTimer = null;
    attempt.started = true;
    session.started = true;
    this.listening = true;
    if (session.readyDelivered) {
      // A restarted recognizer never replays the prompt, cue, or ready event.
      session.restartPending = false;
      return;
    }
    // The earcon is the real microphone-ready signal, not the prompt. Wait for
    // the complete double tone, without turning unavailable audio into a
    // failed microphone.
    const cue = this.play('listening');
    const token = this.cueToken;
    session.readyCueToken = token;
    const played = await cue;
    if (session.readyCueToken === token) session.readyCueToken = null;
    if (!this.current(session)) {
      try { attempt.recognition.abort(); } catch {}
      return;
    }
    // No ready signal means no recording: stop the live input instead of
    // listening without telling the user the microphone is ready.
    if (token !== this.cueToken || played !== true) {
      this.failSession(session, speechError(
        'listening',
        'The start sound could not play, so listening stopped. Check the system sound, then choose Listen to try again.',
      ));
      return;
    }
    session.readyDelivered = true;
    this.startDeadlines(session);
    session.settle?.({ ready: true, sessionId: session.id });
    session.handlers.onReady?.({ sessionId: session.id, cuePlayed: true });
    // The first recognizer may have ended while the cue was still playing.
    if (session.restartPending) this.scheduleRestart(session);
  }

  startDeadlines(session) {
    if (session.deadlinesStarted || !this.current(session)) return;
    session.deadlinesStarted = true;
    const now = Date.now();
    session.initialDeadline = now + INITIAL_SPEECH_TIMEOUT_MS;
    session.commandDeadline = now + COMMAND_TIMEOUT_MS;
    session.initialTimer = setTimeout(() => {
      if (!this.current(session) || session.hasSpeech) return;
      this.endWith(session, 'no-speech');
    }, INITIAL_SPEECH_TIMEOUT_MS);
    session.commandTimer = setTimeout(() => {
      if (!this.current(session)) return;
      this.endWith(session, 'timeout');
    }, COMMAND_TIMEOUT_MS);
  }

  clearPause(session) {
    clearTimeout(session.pauseTimer);
    session.pauseTimer = null;
    session.pauseDeadline = 0;
  }

  resetPause(session) {
    if (!this.current(session) || session.finishing) return;
    this.clearPause(session);
    session.pauseDeadline = Date.now() + SPEECH_PAUSE_MS;
    session.pauseTimer = setTimeout(() => {
      session.pauseTimer = null;
      if (!this.current(session) || session.finishing) return;
      this.beginFinishing(session);
    }, SPEECH_PAUSE_MS);
  }

  // Restarts and native phrase ends must not postpone an existing quiet
  // deadline; only new speech activity may rearm it.
  ensurePause(session) {
    if (session.pauseTimer || session.finishing) return;
    this.resetPause(session);
  }

  handleSpeech(session, attempt, active) {
    if (!this.current(session) || session.attempt !== attempt || attempt.retired) return;
    if (!session.readyDelivered) return;
    session.hasSpeech = true;
    if (active) {
      session.speechActive = true;
      clearTimeout(session.initialTimer);
      session.initialTimer = null;
      this.clearPause(session);
      return;
    }
    session.speechActive = false;
    this.resetPause(session);
  }

  cancelSessionCue(session) {
    const token = session.readyCueToken;
    if (token == null) return;
    session.readyCueToken = null;
    if (token === this.cueToken) this.cancelCue();
  }

  handleResult(session, attempt, event) {
    if (!this.current(session) || session.attempt !== attempt || attempt.retired) return;
    const results = event?.results;
    if (!results) return;
    if (!session.readyDelivered) {
      // Speech before the ready cue is not a command. Remember where it ended
      // so a later cumulative event cannot replay it.
      attempt.ignoredFloor = Math.max(attempt.ignoredFloor, results.length);
      return;
    }
    let heard = false;
    let sawFinal = false;
    let interimPending = false;
    for (let index = 0; index < results.length; index += 1) {
      if (index < attempt.ignoredFloor) continue;
      const result = results[index];
      const text = result?.[0]?.transcript?.trim();
      if (!text) continue;
      if (result.isFinal) {
        if (attempt.finals.get(index) === text) continue;
        attempt.finals.set(index, text);
        sawFinal = true;
        heard = true;
      } else {
        interimPending = true;
        if (attempt.interims.get(index) === text) continue;
        attempt.interims.set(index, text);
        heard = true;
      }
    }
    if (!heard || session.finishing) return;
    session.hasSpeech = true;
    if (sawFinal && !interimPending) {
      // A finalized phrase is the only executable text; interim hypotheses
      // only keep the command alive.
      session.speechActive = false;
      clearTimeout(session.initialTimer);
      session.initialTimer = null;
      this.resetPause(session);
      return;
    }
    session.speechActive = true;
    clearTimeout(session.initialTimer);
    session.initialTimer = null;
    this.clearPause(session);
  }

  flushAttempt(session, attempt) {
    if (attempt.flushed) return;
    attempt.flushed = true;
    const ordered = [...attempt.finals.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, text] of ordered) session.segments.push(text);
  }

  detachAttempt(attempt) {
    if (!attempt) return;
    clearTimeout(attempt.startTimer);
    clearTimeout(attempt.endTimer);
    attempt.startTimer = null;
    attempt.endTimer = null;
    const recognition = attempt.recognition;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
    }
    attempt.retired = true;
  }

  handleError(session, attempt, event) {
    if (!this.current(session) || session.attempt !== attempt || attempt.retired) return;
    const code = event?.error ?? 'error';
    if (!attempt.started) {
      const message = code === 'not-allowed'
        ? 'Microphone permission was denied.'
        : `Could not start recognition: ${code}`;
      this.failSession(session, speechError(code, message));
      return;
    }
    if (code === 'aborted') return;
    if (code === 'no-speech') {
      // Early engine silence is not the user's 15-second window. Wait for the
      // native end before starting a fresh recognizer; a busy instance is
      // never restarted over.
      clearTimeout(attempt.endTimer);
      attempt.endTimer = setTimeout(() => {
        if (!this.current(session) || session.attempt !== attempt || attempt.retired) return;
        try { attempt.recognition.abort(); } catch {}
        this.failSession(session, speechError(
          'recognition',
          'Speech recognition stopped before the microphone released. Choose Listen to try again.',
        ));
      }, ABORT_TIMEOUT_MS);
      return;
    }
    this.failSession(session, speechError(code, `Speech recognition stopped: ${code}. Choose Listen to try again.`));
  }

  handleEnd(session, attempt) {
    if (attempt.retired || session.attempt !== attempt) return;
    clearTimeout(attempt.startTimer);
    attempt.startTimer = null;
    clearTimeout(attempt.endTimer);
    attempt.endTimer = null;
    this.flushAttempt(session, attempt);
    this.detachAttempt(attempt);
    session.attempt = null;
    if (session.ended) return;
    this.listening = false;
    if (session.cancelled || session.failure) {
      this.finishSession(session, session.cancelled ? 'cancelled' : 'error');
      return;
    }
    if (session.finishing) {
      this.completeFinal(session);
      return;
    }
    if (!session.readyDelivered) {
      // The cue may still be playing; restart once readiness is delivered.
      session.restartPending = true;
      return;
    }
    if (!attempt.started) {
      this.failSession(session, speechError('start', 'Chrome could not start speech recognition. Choose Listen to try again.'));
      return;
    }
    // A native end closes one phrase, not the command. Keep what was finalized
    // and restart on the same isolated track without extending a quiet deadline.
    session.speechActive = false;
    if (session.hasSpeech) this.ensurePause(session);
    this.scheduleRestart(session);
  }

  scheduleRestart(session) {
    if (!this.current(session) || session.finishing || session.restartTimer) return;
    this.trace(session, 'recognizer.restart');
    session.restartPending = false;
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (!this.current(session) || session.finishing) return;
      this.startAttempt(session);
    }, RECOGNITION_RESTART_MS);
  }

  beginFinishing(session) {
    if (!this.current(session) || session.finishing) return;
    session.finishing = true;
    this.clearListeningTimers(session);
    const attempt = session.attempt;
    if (!attempt) {
      this.completeFinal(session);
      return;
    }
    clearTimeout(attempt.endTimer);
    attempt.endTimer = setTimeout(() => {
      if (!this.current(session) || session.attempt !== attempt) return;
      try { attempt.recognition.abort(); } catch {}
      this.completeFinal(session);
    }, ABORT_TIMEOUT_MS);
    try {
      attempt.recognition.stop();
    } catch {
      try { attempt.recognition.abort(); } catch {}
      this.completeFinal(session);
    }
  }

  completeFinal(session) {
    if (session.ended || session.finalDelivered) return;
    const attempt = session.attempt;
    if (attempt) {
      this.flushAttempt(session, attempt);
      this.detachAttempt(attempt);
      session.attempt = null;
    }
    if (session.ended || session.finalDelivered) return;
    session.finalDelivered = true;
    session.reason = 'final';
    this.clearTimers(session);
    this.listening = false;
    this.releaseInput(session);
    const text = session.segments.join(' ').replace(/\s+/gu, ' ').trim();
    this.finishSession(session, text ? 'final' : 'no-speech');
    if (text) session.handlers.onResult?.(text, { sessionId: session.id });
    session.handlers.onEnd?.({ sessionId: session.id, reason: text ? 'final' : 'no-speech' });
  }

  endWith(session, reason) {
    if (!this.current(session) || session.finishing) return;
    this.trace(session, 'session.end', { reason, hasSpeech: Boolean(session.hasSpeech) });
    session.terminal = true;
    session.reason = reason;
    this.clearTimers(session);
    this.listening = false;
    this.releaseInput(session);
    const attempt = session.attempt;
    if (attempt) {
      this.detachAttempt(attempt);
      try { attempt.recognition.abort(); } catch {}
      session.attempt = null;
    }
    this.cancelSessionCue(session);
    this.finishSession(session, reason);
    session.handlers.onEnd?.({ sessionId: session.id, reason });
  }

  failSession(session, error) {
    if (session.failure || session.ended) return;
    this.trace(session, 'session.fail', { code: error?.code ?? null, message: error?.message ?? null });
    session.failure = error;
    session.reason = 'error';
    this.listening = false;
    this.clearTimers(session);
    const deliveredReady = session.readyDelivered;
    session.settle?.({ error });
    if (session.closing) return;
    session.closing = true;
    // Release the device and cue now, but let a delayed native end settle the
    // recognizer so the next request can bind a fresh instance safely.
    this.abortSession(session);
    this.armEndDeadline(session, 'error');
    if (deliveredReady && !session.errorDelivered) {
      session.errorDelivered = true;
      session.handlers.onError?.(error?.code ?? 'error');
    }
  }

  clearTimers(session) {
    clearTimeout(session.startTimer);
    clearTimeout(session.endTimer);
    clearTimeout(session.initialTimer);
    clearTimeout(session.pauseTimer);
    clearTimeout(session.commandTimer);
    clearTimeout(session.restartTimer);
    session.startTimer = null;
    session.endTimer = null;
    session.initialTimer = null;
    session.pauseTimer = null;
    session.commandTimer = null;
    session.restartTimer = null;
    const attempt = session.attempt;
    if (attempt) {
      clearTimeout(attempt.startTimer);
      clearTimeout(attempt.endTimer);
      attempt.startTimer = null;
      attempt.endTimer = null;
    }
  }

  clearListeningTimers(session) {
    clearTimeout(session.initialTimer);
    clearTimeout(session.pauseTimer);
    clearTimeout(session.commandTimer);
    clearTimeout(session.restartTimer);
    session.initialTimer = null;
    session.pauseTimer = null;
    session.commandTimer = null;
    session.restartTimer = null;
    const attempt = session.attempt;
    if (attempt) {
      clearTimeout(attempt.startTimer);
      attempt.startTimer = null;
    }
  }

  // Idempotent: a late stream, a final result, and a cancel may all race here.
  releaseInput(session) {
    if (!session) return;
    if (session.track) session.track.onended = null;
    session.track = null;
    const stream = session.stream;
    session.stream = null;
    releaseStream(stream);
  }

  abortSession(session) {
    this.cancelSessionCue(session);
    this.releaseInput(session);
    const recognition = session.attempt?.recognition ?? session.recognition;
    try { recognition?.abort(); } catch {}
  }

  // Only a session that never reached native start may finish without onend;
  // otherwise wait a bounded time, abort once more, then abandon the old
  // recognizer. The next listen request gets a fresh instance instead of a reload gate.
  armEndDeadline(session, reason) {
    clearTimeout(session.endTimer);
    session.endTimer = null;
    if (!session.startRequested) {
      this.finishSession(session, reason);
      return;
    }
    session.endTimer = setTimeout(() => {
      if (session.ended) return;
      const recognition = session.attempt?.recognition ?? session.recognition;
      try { recognition?.abort(); } catch {}
      this.finishSession(session, reason);
    }, ABORT_TIMEOUT_MS);
  }

  finishSession(session, reason) {
    if (session.ended) return;
    session.ended = true;
    session.reason ??= reason;
    this.clearTimers(session);
    this.cancelSessionCue(session);
    this.releaseInput(session);
    if (session.attempt) this.detachAttempt(session.attempt);
    session.attempt = null;
    const recognition = session.recognition;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      if (this.recognition === recognition) this.recognition = null;
    }
    if (this.session === session) this.listening = false;
    if (!session.settled) session.settle?.({ ready: false, cancelled: session.cancelled, sessionId: session.id });
    session.resolveEnd?.();
  }

  stopListening() {
    const session = this.session;
    // Every stop revokes requests already waiting for the old session to end.
    this.inputGeneration += 1;
    this.listening = false;
    if (!session || session.ended) return;
    // A delivered final already owns the outcome; a later readback announcement
    // must not relabel it as cancelled.
    if (session.finalDelivered) {
      this.releaseInput(session);
      return;
    }
    if (session.closing) return;
    session.closing = true;
    session.cancelled = true;
    session.reason = 'cancelled';
    if (!session.settled) session.settle?.({ ready: false, cancelled: true, sessionId: session.id });
    this.clearTimers(session);
    this.abortSession(session);
    this.armEndDeadline(session, 'cancelled');
  }

  async openMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw speechError('mic', 'Microphone access is not available');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  }

  // One native prompt per panel while the request is unsettled; the probe
  // stream is always stopped. A later explicit retry may prompt again.
  requestMicrophone() {
    if (this.microphonePromise) return this.microphonePromise;
    const pending = this.openMicrophone();
    this.microphonePromise = pending;
    pending
      .finally(() => {
        if (this.microphonePromise === pending) this.microphonePromise = null;
      })
      .catch(() => {});
    return pending;
  }
}
