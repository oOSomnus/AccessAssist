// Speech output and recognition. Pure helpers are exported for unit tests; the
// class touches Chrome APIs only when its methods run.
export const SOUND_CUES = Object.freeze({
  typing: [[660, 80], [440, 80]],
  choose: [[660, 80]],
  cancel: [[440, 80], [220, 120]],
  fail: [[220, 80], [220, 80]],
  listening: [[880, 80]],
  working: [[440, 50], [550, 50]],
});

const START_TIMEOUT_MS = 10_000;
const ABORT_TIMEOUT_MS = 2_000;
const RESUME_TIMEOUT_MS = 2_000;
const CUE_GRACE_MS = 2_000;
const CUE_GAIN = 0.15;
const WORKING_GAIN = 0.035;
const WORKING_DELAY_MS = 400;
const WORKING_GAP_MS = 1200;
const WORKING_FAILURES = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function speechError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function pickVoice(voices, lang) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const exact = voices.filter((voice) => voice.lang === lang);
  const prefix = voices.filter((voice) => voice.lang?.startsWith(lang.split('-')[0]));
  const pool = exact.length ? exact : prefix;
  if (!pool.length) return null;
  return pool.find((voice) => voice.localService) ?? pool[0];
}

export function chunkText(text, max = 32_000) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  if (value.length <= max) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('; '), window.lastIndexOf('\n'),
    );
    const end = cut > max * 0.6 ? cut + 1 : max;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function localRecognitionSupported(Recognition) {
  return typeof Recognition?.available === 'function';
}

export class Speech {
  constructor({ lang = 'en-US', outputMode = 'tts' } = {}) {
    this.lang = lang;
    this.outputMode = outputMode;
    this.statusEl = null;
    this.alertEl = null;
    this.audio = null;
    this.voiceName = null;
    this.speaking = false;
    this.listening = false;
    this.generation = 0;
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
    this.currentChunk = null;
    this.stopReason = null;
    this.promptSession = null;
    this.promptGeneration = null;
    this.workingActive = false;
    this.workingTimer = null;
    this.workingToken = 0;
    this.workingNodes = null;
    this.workingFailures = 0;
  }

  attach({ statusEl, alertEl }) {
    this.statusEl = statusEl;
    this.alertEl = alertEl;
  }

  setOutputMode(mode) {
    this.outputMode = mode === 'screen-reader' ? 'screen-reader' : 'tts';
  }

  async loadVoice() {
    try {
      const voices = await chrome.tts.getVoices();
      this.voiceName = pickVoice(voices, this.lang)?.voiceName ?? null;
    } catch {
      this.voiceName = null;
    }
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
      let offset = 0;
      for (const [frequency, duration] of cue) {
        const oscillator = this.audio.createOscillator();
        const gain = this.audio.createGain();
        nodes.push({ oscillator, gain });
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(CUE_GAIN, start + offset + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration / 1000);
        oscillator.connect(gain).connect(this.audio.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration / 1000);
        offset += duration / 1000;
      }
      nodes.at(-1).oscillator.onended = () => {
        release(false);
        finish(true);
      };
      const totalMs = cue.reduce((sum, [, duration]) => sum + duration, 0);
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

  scheduleWorking(delay) {
    if (!this.workingActive || this.workingTimer) return;
    const token = this.workingToken;
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      void this.playWorkingGroup(token);
    }, delay);
  }

  async playWorkingGroup(token) {
    if (!this.workingActive || token !== this.workingToken) return;
    // Spoken output, listening, and earcons win; retry after the gap.
    if (this.speaking || this.listening || this.cuePromise) {
      this.scheduleWorking(WORKING_GAP_MS);
      return;
    }
    const running = await this.resumeAudio();
    if (!this.workingActive || token !== this.workingToken) return;
    if (!running || !this.audio) {
      this.workingFailures += 1;
      if (this.workingFailures >= WORKING_FAILURES) {
        this.stopWorking();
        this.writeStatus('The working sound could not play. Spoken controls still work.', true);
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

  writeStatus(text, alert = false) {
    const target = alert ? this.alertEl : this.statusEl;
    if (target) target.textContent = String(text);
  }

  speakChunk(text) {
    return new Promise((resolve) => {
      let settled = false;
      const chunk = { finish: null };
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.currentChunk === chunk) this.currentChunk = null;
        resolve(ok);
      };
      chunk.finish = finish;
      this.currentChunk = chunk;
      const timer = setTimeout(() => finish(false), Math.min(30_000, 2000 + text.length * 100));
      try {
        chrome.tts.speak(text, {
          lang: this.lang,
          rate: 1,
          pitch: 1,
          volume: 1,
          ...(this.voiceName ? { voiceName: this.voiceName } : {}),
          onEvent: (event) => {
            if (event.type === 'end') {
              finish(true);
            } else if (event.type === 'error' || event.type === 'interrupted' || event.type === 'cancelled') {
              finish(false);
            }
          },
        });
      } catch {
        finish(false);
      }
    });
  }

  // forceSpeech bypasses the screen-reader output mode for mandatory status
  // words and for reading recognized speech back before it is used; ordinary
  // answers keep the user's chosen output.
  async announce(text, { alert = false, keepListening = false, forceSpeech = false } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return { spoken: true, interrupted: false, reason: null };
    if (!keepListening) this.stopListening();
    if (this.speaking || this.currentChunk) this.stopSpeaking('replaced');
    const generation = ++this.generation;
    this.stopReason = null;
    this.speaking = true;
    const interrupted = () => ({ spoken: false, interrupted: true, reason: this.stopReason ?? 'replaced' });
    try {
      if (this.outputMode === 'screen-reader' && !forceSpeech) {
        this.writeStatus(value, alert);
        return { spoken: true, interrupted: false, reason: null };
      }
      let spoken = true;
      for (const chunk of chunkText(value)) {
        if (generation !== this.generation) return interrupted();
        const ok = await this.speakChunk(chunk);
        if (generation !== this.generation) return interrupted();
        if (!ok) {
          spoken = false;
          break;
        }
      }
      if (!spoken) this.writeStatus(value, alert);
      return { spoken, interrupted: false, reason: null };
    } finally {
      if (generation === this.generation) this.speaking = false;
    }
  }

  // Settles the blocked chunk even when Chrome sends no event for stop(), so a
  // late event can never touch newer output.
  stopSpeaking(reason = 'user') {
    this.generation += 1;
    this.stopReason = reason;
    this.speaking = false;
    const chunk = this.currentChunk;
    this.currentChunk = null;
    chunk?.finish(false);
    try {
      chrome.tts.stop();
    } catch {}
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
      recognition.interimResults = false;
      recognition.continuous = false;
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

  async ensureRecognitionReady() {
    // Every listening session owns a fresh native recognizer. A previous
    // session that lost its end event can never block the next Alt+Z.
    this.recognition = null;
    const recognition = this.ensureRecognition();
    if (!('processLocally' in recognition)) {
      throw speechError('unsupported', 'This Chrome does not support local speech recognition.');
    }
    if (!this.localAvailable) await this.refreshLocalStatus();
    if (!this.localAvailable) {
      throw speechError('unavailable', 'The English speech pack is still being prepared. Try again in a moment.');
    }
    try {
      recognition.processLocally = true;
    } catch {}
    if (recognition.processLocally !== true) {
      throw speechError('local', 'Chrome refused to keep speech recognition on this device.');
    }
    return recognition;
  }

  current(session) {
    return this.session === session && !session.ended && !session.cancelled
      && !session.closing && !session.failure;
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
      startTimer: null,
      endTimer: null,
      readyCueToken: null,
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
    let recognition;
    try {
      recognition = await this.ensureRecognitionReady();
    } catch (error) {
      this.failSession(session, error);
      return;
    }
    if (!this.current(session)) {
      this.finishSession(session, 'cancelled');
      return;
    }
    session.recognition = recognition;
    // The word must finish before the microphone opens, so the recognizer can
    // never capture the assistant's own prompt.
    const prompt = this.announce('Listening', { forceSpeech: true, keepListening: true });
    const promptGeneration = this.generation;
    this.promptSession = session;
    this.promptGeneration = promptGeneration;
    const outcome = await prompt;
    if (this.promptSession === session && this.promptGeneration === promptGeneration) {
      this.promptSession = null;
      this.promptGeneration = null;
    }
    if (!this.current(session)) {
      this.finishSession(session, 'cancelled');
      return;
    }
    if (outcome.interrupted) {
      this.stopListening();
      return;
    }
    if (!outcome.spoken) {
      this.failSession(session, speechError(
        'listening',
        'The listening prompt could not be spoken. Check the speech output, then press Alt+Z to try again.',
      ));
      return;
    }
    this.bindRecognition(session);
    session.startTimer = setTimeout(() => {
      if (session.started || session.ended) return;
      this.failSession(session, speechError('start-timeout', 'Chrome did not start listening. Press Alt+Z to try again.'));
    }, START_TIMEOUT_MS);
    // Set before the native call: a throwing start() can still leave the
    // recognizer active, so this session must also release through onend.
    session.startRequested = true;
    try {
      recognition.start();
    } catch (error) {
      this.failSession(session, speechError('start', `Could not start recognition: ${error?.message ?? 'try again'}`));
    }
  }

  bindRecognition(session) {
    const recognition = session.recognition;
    recognition.onstart = () => { void this.handleStart(session); };
    recognition.onresult = (event) => { this.handleResult(session, event); };
    recognition.onerror = (event) => { this.handleError(session, event); };
    recognition.onend = () => { this.handleEnd(session); };
  }

  async handleStart(session) {
    if (!this.current(session)) {
      // An abort issued while start was in flight may not have taken effect;
      // release this old recognizer again without touching a newer session.
      try { session.recognition?.abort(); } catch {}
      return;
    }
    if (session.started) return;
    clearTimeout(session.startTimer);
    session.started = true;
    this.listening = true;
    // The earcon is the real microphone-ready signal, not the prompt. Wait for
    // this session's cue, without turning unavailable audio into a failed mic.
    const cue = this.play('listening');
    const token = this.cueToken;
    session.readyCueToken = token;
    const played = await cue;
    if (session.readyCueToken === token) session.readyCueToken = null;
    if (!this.current(session)) {
      try { session.recognition?.abort(); } catch {}
      return;
    }
    if (token !== this.cueToken) {
      this.failSession(session, speechError(
        'listening',
        'The start sound was replaced before listening began. Press Alt+Z to try again.',
      ));
      return;
    }
    session.readyDelivered = true;
    session.settle?.({ ready: true, sessionId: session.id });
    session.handlers.onReady?.({ sessionId: session.id, cuePlayed: played === true });
  }

  cancelSessionCue(session) {
    const token = session.readyCueToken;
    if (token == null) return;
    session.readyCueToken = null;
    if (token === this.cueToken) this.cancelCue();
  }

  handleResult(session, event) {
    if (!this.current(session)) return;
    if (session.finalDelivered) return;
    const last = event.results?.[event.results.length - 1];
    if (!last?.isFinal) return;
    const text = last[0]?.transcript?.trim();
    if (!text) return;
    if (!session.readyDelivered) return;
    if (this.speaking) return;
    session.finalDelivered = true;
    session.reason = 'final';
    this.listening = false;
    try { session.recognition.stop(); } catch {}
    session.handlers.onResult?.(text, { sessionId: session.id });
  }

  handleError(session, event) {
    if (!this.current(session)) return;
    session.reason = event.error ?? 'error';
    this.listening = false;
    if (!session.started) {
      const message = event.error === 'not-allowed'
        ? 'Microphone permission was denied.'
        : `Could not start recognition: ${event.error ?? 'unknown error'}`;
      this.failSession(session, speechError(event.error ?? 'start', message));
      return;
    }
    if (event.error !== 'aborted' && event.error !== 'no-speech') session.handlers.onError?.(event.error);
  }

  handleEnd(session) {
    if (session.ended) return;
    const wasCurrent = this.session === session;
    if (!session.started && !session.settled) {
      session.settle?.({ ready: false, cancelled: session.cancelled, sessionId: session.id });
    }
    const reason = session.reason ?? (session.cancelled ? 'cancelled' : 'end');
    this.finishSession(session, reason);
    if (wasCurrent && !session.cancelled) session.handlers.onEnd?.({ sessionId: session.id, reason });
  }

  failSession(session, error) {
    if (session.failure) return;
    session.failure = error;
    session.reason = 'error';
    session.settle?.({ error });
    if (session.closing) return;
    session.closing = true;
    this.abortSession(session);
    this.armEndDeadline(session, 'error');
  }

  abortSession(session) {
    this.cancelSessionCue(session);
    try { session.recognition?.abort(); } catch {}
  }

  // Only a session that never reached native start may finish without onend;
  // otherwise wait a bounded time, abort once more, then abandon the old
  // recognizer. The next Alt+Z gets a fresh instance instead of a reload gate.
  armEndDeadline(session, reason) {
    clearTimeout(session.endTimer);
    session.endTimer = null;
    if (!session.startRequested) {
      this.finishSession(session, reason);
      return;
    }
    session.endTimer = setTimeout(() => {
      if (session.ended) return;
      try { session.recognition?.abort(); } catch {}
      this.finishSession(session, reason);
    }, ABORT_TIMEOUT_MS);
  }

  finishSession(session, reason) {
    if (session.ended) return;
    session.ended = true;
    session.reason ??= reason;
    clearTimeout(session.startTimer);
    clearTimeout(session.endTimer);
    this.cancelSessionCue(session);
    const recognition = session.recognition;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (this.recognition === recognition) this.recognition = null;
    }
    if (this.session === session) this.listening = false;
    if (this.promptSession === session) {
      this.promptSession = null;
      this.promptGeneration = null;
    }
    if (!session.settled) session.settle?.({ ready: false, cancelled: session.cancelled, sessionId: session.id });
    session.resolveEnd?.();
  }

  stopListening() {
    const session = this.session;
    // Every stop revokes requests already waiting for the old session to end.
    this.inputGeneration += 1;
    this.listening = false;
    // Only the source session's own pending prompt may be stopped; a newer
    // announcement owns a different generation and must keep speaking.
    if (session && this.promptSession === session && this.promptGeneration === this.generation) {
      this.promptSession = null;
      this.promptGeneration = null;
      this.stopSpeaking('user');
    }
    if (!session || session.ended || session.closing) return;
    session.closing = true;
    session.cancelled = true;
    session.reason = 'cancelled';
    if (!session.settled) session.settle?.({ ready: false, cancelled: true, sessionId: session.id });
    clearTimeout(session.startTimer);
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
