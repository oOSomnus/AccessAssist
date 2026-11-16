import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOUND_CUES,
  Speech,
  chunkText,
  localRecognitionSupported,
  pickVoice,
} from '../../extension/speech.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function resultEvent(transcript, final = true) {
  const item = [{ transcript, confidence: 1 }];
  item.isFinal = final;
  return { results: [item], resultIndex: 0 };
}

function fakeBrowser({
  status = 'available',
  install = true,
  audio = 'suspended',
  resume = false,
  holdStart = false,
  holdEnd = false,
  dropEnd = false,
  holdSpeech = false,
  failSpeech = false,
  failStart = 0,
  autoCue = true,
} = {}) {
  const control = {
    available: status,
    installCalls: [],
    starts: 0,
    startArgs: [],
    spoken: [],
    speechOptions: [],
    heldSpeech: [],
    stopCalls: 0,
    aborts: 0,
    oscillators: [],
    gains: [],
    scheduledStops: 0,
    immediateStops: 0,
    resumeCalls: 0,
    recognition: null,
    recognitions: [],
    nativeBusy: false,
    activeRecognition: null,
    cueTimers: [],
    ttsHold: holdSpeech,
    ttsFail: failSpeech,
    holdStart,
    releaseEnd() {
      const recognition = control.activeRecognition ?? control.recognition;
      if (!recognition) return;
      recognition.active = false;
      control.nativeBusy = false;
      control.activeRecognition = null;
      queueMicrotask(() => recognition.onend?.());
    },
    releaseSpeech() {
      control.ttsHold = false;
      for (const options of control.heldSpeech.splice(0)) {
        queueMicrotask(() => options.onEvent({ type: 'end' }));
      }
    },
    releaseStart() {
      if (control.recognition?.active) control.recognition.onstart?.();
    },
    finishCue() {
      for (const timer of control.cueTimers.splice(0)) clearTimeout(timer);
      for (const oscillator of control.oscillators.splice(0)) oscillator.onended?.();
    },
    playableOscillators() {
      return control.oscillators.filter((oscillator) => (
        oscillator.started && !oscillator.ended && !oscillator.disconnected
      ));
    },
    suspendAudio() {
      if (control.audio) control.audio.state = 'suspended';
    },
    resumeAudio() {
      if (control.audio) control.audio.state = 'running';
    },
    // Audio time advances only while the context runs; mocked wall time never moves it.
    advanceAudio(ms) {
      if (!control.audio || control.audio.state !== 'running') return control.audio?.currentTime ?? 0;
      control.audio.currentTime += ms / 1000;
      for (const oscillator of control.oscillators) {
        if (!oscillator.ended && oscillator.stopAt != null && oscillator.stopAt <= control.audio.currentTime) {
          oscillator.ended = true;
          oscillator.onended?.();
        }
      }
      return control.audio.currentTime;
    },
  };
  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.interimResults = true;
      this.continuous = true;
      this.maxAlternatives = 3;
      this.active = false;
      this.processLocally = undefined;
      control.recognition = this;
      control.recognitions.push(this);
    }

    static available(args) {
      control.availableArgs = args;
      const value = control.available;
      return Promise.resolve(typeof value === 'function' ? value() : value);
    }

    static install(args) {
      control.installCalls.push(args);
      return typeof install === 'function' ? install() : Promise.resolve(install);
    }

    start(track) {
      // The microphone is shared: a second instance cannot start while the
      // previous native session still holds it.
      if (this.active || control.nativeBusy) {
        throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
      }
      this.active = true;
      control.nativeBusy = true;
      control.activeRecognition = this;
      control.starts += 1;
      control.startArgs.push(track ?? null);
      if (control.starts <= failStart) throw new Error('could not start');
      if (!control.holdStart) queueMicrotask(() => this.onstart?.());
    }

    stop() {
      if (!this.active || holdEnd) return;
      this.active = false;
      control.nativeBusy = false;
      if (dropEnd) return;
      queueMicrotask(() => this.onend?.());
    }

    abort() {
      control.aborts += 1;
      // A held end keeps the native recognizer active, like Chrome during a
      // delayed teardown; releaseEnd() then delivers the queued onend.
      if (holdEnd || !this.active) return;
      this.active = false;
      control.nativeBusy = false;
      if (dropEnd) return;
      queueMicrotask(() => this.onend?.());
    }
  }
  class FakeAudioContext {
    constructor() {
      this.state = audio;
      this.currentTime = 0;
      this.destination = {};
      control.audio = this;
    }

    async resume() {
      control.resumeCalls += 1;
      if (!resume) return;
      this.state = 'running';
    }

    createOscillator() {
      const oscillator = {
        frequency: {},
        onended: null,
        started: false,
        ended: false,
        disconnected: false,
        stoppedImmediately: false,
        startAt: null,
        stopAt: null,
        connect: (node) => node,
        start(when = 0) {
          oscillator.started = true;
          oscillator.startAt = when;
        },
        stop(when) {
          if (when === undefined) {
            control.immediateStops += 1;
            oscillator.stoppedImmediately = true;
            oscillator.ended = true;
            oscillator.stopAt = null;
            return;
          }
          control.scheduledStops += 1;
          oscillator.stopAt = when;
        },
        disconnect() {
          oscillator.disconnected = true;
        },
      };
      control.oscillators.push(oscillator);
      if (autoCue) queueMicrotask(() => oscillator.onended?.());
      return oscillator;
    }

    createGain() {
      const gain = {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        disconnected: false,
        connect: (node) => node,
        disconnect() {
          gain.disconnected = true;
        },
      };
      control.gains.push(gain);
      return gain;
    }
  }
  globalThis.SpeechRecognition = FakeRecognition;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.chrome = {
    tts: {
      getVoices: async () => [],
      speak(text, options) {
        control.spoken.push(String(text));
        control.speechOptions.push(options);
        if (control.ttsFail) {
          queueMicrotask(() => options.onEvent?.({ type: 'error' }));
          return;
        }
        if (control.ttsHold) {
          control.heldSpeech.push(options);
          return;
        }
        queueMicrotask(() => options.onEvent?.({ type: 'end' }));
      },
      stop() {
        control.stopCalls += 1;
        for (const options of control.heldSpeech.splice(0)) {
          queueMicrotask(() => options.onEvent?.({ type: 'interrupted' }));
        }
      },
    },
  };
  return control;
}

function clearBrowser() {
  delete globalThis.SpeechRecognition;
  delete globalThis.AudioContext;
  delete globalThis.chrome;
}

test('voice selection prefers exact language and local voices', () => {
  const voices = [
    { voiceName: 'remote-en', lang: 'en-US', localService: false },
    { voiceName: 'remote-gb', lang: 'en-GB', localService: false },
    { voiceName: 'local-en', lang: 'en-GB', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en-GB').voiceName, 'local-en');
  assert.equal(pickVoice([{ voiceName: 'en', lang: 'en-US', localService: true }], 'fr-FR'), null);
  assert.equal(pickVoice([], 'en-US'), null);
});

test('long text is cut at sentence boundaries within the limit', () => {
  const sentence = 'This is a sentence used to test the splitter. ';
  const text = sentence.repeat(5000).trim();
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.equal(chunks.join(' '), text);
});

test('local recognition capability is detected explicitly', () => {
  assert.equal(localRecognitionSupported({ available: async () => 'available' }), true);
  assert.equal(localRecognitionSupported({}), false);
});

test('every command cue has at least one short tone', () => {
  for (const [name, cue] of Object.entries(SOUND_CUES)) {
    assert.ok(cue.length > 0, name);
    for (const [frequency, duration] of cue) {
      assert.ok(frequency >= 200 && frequency <= 1000, name);
      assert.ok(duration >= 40 && duration <= 200, name);
    }
  }
});

test('local status reports every capability state without guessing', async () => {
  for (const status of ['available', 'downloadable', 'downloading', 'unavailable']) {
    const control = fakeBrowser({ status });
    try {
      const speech = new Speech();
      assert.equal(await speech.getLocalRecognitionStatus(), status);
      assert.deepEqual(control.availableArgs, { langs: ['en-US'], processLocally: true });
    } finally {
      clearBrowser();
    }
  }
  const control = fakeBrowser();
  globalThis.SpeechRecognition.available = () => Promise.reject(new Error('blocked'));
  try {
    assert.equal(await new Speech().getLocalRecognitionStatus(), 'error');
  } finally {
    clearBrowser();
  }
});

test('install starts before any await and is shared without gating readiness', async () => {
  const control = fakeBrowser({ status: 'downloadable', install: () => new Promise(() => {}) });
  try {
    const speech = new Speech();
    const first = speech.startLocalRecognitionInstall();
    assert.deepEqual(control.installCalls, [{ langs: ['en-US'], processLocally: true }]);
    assert.equal(speech.startLocalRecognitionInstall(), first);
    const seen = [];
    const monitor = speech.waitForLocalRecognition({
      intervalMs: 5,
      onStatus: (status) => seen.push(status),
    });
    assert.equal(control.installCalls.length, 1);
    control.available = 'available';
    assert.equal(await monitor, 'available');
    assert.deepEqual(seen.slice(0, 2), ['downloadable', 'available']);
    assert.equal(speech.localAvailable, true);
  } finally {
    clearBrowser();
  }
});

test('a downloading pack is observed instead of reinstalled', async () => {
  const control = fakeBrowser({ status: 'downloading' });
  try {
    const speech = new Speech();
    speech.localStatus = 'downloading';
    const pending = speech.startLocalRecognitionInstall();
    const raced = await Promise.race([pending.then(() => 'settled'), tick(20).then(() => 'pending')]);
    assert.equal(raced, 'pending');
    assert.deepEqual(control.installCalls, []);
  } finally {
    clearBrowser();
  }
});

test('a slow pack download announces once and keeps polling at the slow interval', async () => {
  const control = fakeBrowser({ status: 'downloadable' });
  try {
    const speech = new Speech();
    let slow = 0;
    const monitor = speech.waitForLocalRecognition({
      intervalMs: 2,
      slowAfterMs: 0,
      slowIntervalMs: 3,
      onSlow: () => { slow += 1; },
    });
    await tick(5);
    assert.equal(slow, 1);
    control.available = 'available';
    assert.equal(await monitor, 'available');
    assert.equal(slow, 1);
  } finally {
    clearBrowser();
  }
});

test('install is skipped when availability was already verified', async () => {
  const control = fakeBrowser({ status: 'available' });
  try {
    const speech = new Speech();
    await speech.refreshLocalStatus();
    assert.equal(await speech.startLocalRecognitionInstall(), true);
    assert.equal(control.installCalls.length, 0);
  } finally {
    clearBrowser();
  }
});

test('a refused or rejected install stays recoverable', async () => {
  fakeBrowser({ status: 'downloadable', install: () => Promise.resolve(false) });
  try {
    const speech = new Speech();
    assert.equal(await speech.startLocalRecognitionInstall(), false);
    assert.equal(speech.localAvailable, false);
  } finally {
    clearBrowser();
  }
  fakeBrowser({ status: 'downloadable', install: () => Promise.reject(new Error('denied')) });
  try {
    const speech = new Speech();
    await assert.rejects(speech.startLocalRecognitionInstall(), /denied/u);
    assert.equal(speech.localAvailable, false);
  } finally {
    clearBrowser();
  }
});

test('availability monitoring follows every state and stops on abort', async () => {
  const control = fakeBrowser({ status: 'downloadable' });
  try {
    const speech = new Speech();
    const seen = [];
    const monitor = speech.waitForLocalRecognition({
      intervalMs: 5,
      onStatus: (status) => seen.push(status),
    });
    control.available = 'downloading';
    await tick(12);
    control.available = 'available';
    assert.equal(await monitor, 'available');
    assert.deepEqual(seen.slice(0, 3), ['downloadable', 'downloading', 'available']);
  } finally {
    clearBrowser();
  }
  const second = fakeBrowser({ status: 'downloadable' });
  try {
    const speech = new Speech();
    const controller = new AbortController();
    const monitor = speech.waitForLocalRecognition({ intervalMs: 5, signal: controller.signal });
    controller.abort();
    assert.equal(await monitor, 'aborted');
  } finally {
    clearBrowser();
    void second;
  }
});

test('Listening is spoken before the microphone opens and one final is accepted', async () => {
  const control = fakeBrowser({ holdSpeech: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onReady: (info) => ready.push(info),
      onResult: (text, info) => results.push([text, info.sessionId]),
      onEnd: (info) => ends.push(info),
    });
    await tick();
    // The word is still playing, so no native session may exist yet.
    assert.equal(control.spoken[0], 'Listening');
    assert.equal(control.starts, 0);
    assert.equal(control.recognition.active, false);

    control.releaseSpeech();
    await tick();
    assert.equal(control.starts, 1);
    const outcome = await pending;
    assert.equal(outcome.ready, true);
    assert.equal(ready.length, 1);

    control.recognition.onresult(resultEvent('one', false));
    assert.deepEqual(results, []);
    control.recognition.onresult(resultEvent('one'));
    control.recognition.onresult(resultEvent('one'));
    await tick();
    assert.equal(results.length, 1);
    assert.equal(results[0][0], 'one');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'final');
    assert.equal(control.recognition.active, false);
  } finally {
    clearBrowser();
  }
});

test('the start tone follows the native start and gates readiness', async () => {
  const control = fakeBrowser({ holdStart: true, audio: 'running', autoCue: false });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const results = [];
    const pending = speech.startListening({
      onReady: (info) => ready.push(info),
      onResult: (text) => results.push(text),
    });
    await tick();
    assert.equal(control.starts, 1);
    // The recognized microphone is open, but no ready signal or tone yet.
    assert.deepEqual(control.oscillators, []);
    assert.deepEqual(ready, []);

    control.recognition.onstart?.();
    control.recognition.onstart?.();
    await tick();
    assert.equal(control.oscillators.length, 1);
    assert.equal(control.oscillators[0].frequency.value, 880);
    assert.deepEqual(ready, []);

    control.recognition.onresult(resultEvent('one'));
    await tick();
    assert.deepEqual(results, []);

    control.finishCue();
    const outcome = await pending;
    assert.deepEqual(outcome, { ready: true, sessionId: 1 });
    assert.equal(ready.length, 1);
    assert.equal(ready[0].cuePlayed, true);

    control.recognition.onresult(resultEvent('one'));
    await tick();
    assert.deepEqual(results, ['one']);
  } finally {
    clearBrowser();
  }
});

test('an unavailable start tone still becomes ready and accepts one final', async () => {
  const control = fakeBrowser({ audio: 'suspended' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const results = [];
    const pending = speech.startListening({
      onReady: (info) => ready.push(info),
      onResult: (text) => results.push(text),
    });
    const outcome = await pending;
    assert.deepEqual(outcome, { ready: true, sessionId: 1 });
    assert.equal(control.starts, 1);
    assert.deepEqual(control.oscillators, []);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].cuePlayed, false);
    control.recognition.onresult(resultEvent('help'));
    await tick();
    assert.deepEqual(results, ['help']);
  } finally {
    clearBrowser();
  }
});

test('a held start tone cancels without readiness and spares the next cue', async () => {
  const control = fakeBrowser({ audio: 'running', autoCue: false });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await tick();
    await tick();
    assert.equal(control.oscillators.length, 1);

    speech.stopListening();
    assert.deepEqual(await first, { ready: false, cancelled: true, sessionId: 1 });
    const staleCue = control.oscillators[0];
    control.releaseEnd();
    await tick();

    const second = speech.startListening({});
    await tick();
    await tick();
    assert.equal(control.oscillators.length, 2);
    const secondToken = speech.session.readyCueToken;
    assert.ok(secondToken);

    // A late callback from the cancelled cue must not end the new one.
    staleCue.onended?.();
    await tick(10);
    assert.equal(speech.session.readyDelivered, false);
    assert.equal(speech.session.readyCueToken, secondToken);

    control.oscillators[1].onended?.();
    const outcome = await second;
    assert.equal(outcome.ready, true);
    assert.equal(outcome.sessionId, 2);
  } finally {
    clearBrowser();
  }
});

test('an active session is reused instead of starting recognition twice', async () => {
  const control = fakeBrowser({ audio: 'running' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await tick();
    const second = speech.startListening({});
    await tick();
    assert.equal(control.starts, 1);
    assert.deepEqual(await first, { ready: true, sessionId: 1 });
    assert.deepEqual(await second, { ready: true, sessionId: 1 });
  } finally {
    clearBrowser();
  }
});

test('stopping a pending session cancels readiness and ignores stale callbacks', async () => {
  const control = fakeBrowser({ holdSpeech: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await tick();
    speech.stopListening();
    const outcome = await pending;
    assert.equal(outcome.ready, false);
    assert.equal(outcome.cancelled, true);
    await tick();
    assert.deepEqual(results, []);
    assert.equal(ends.length, 0);
    assert.equal(speech.listening, false);
  } finally {
    clearBrowser();
  }
});

test('a failed Listening prompt stops before the microphone opens', async () => {
  const control = fakeBrowser({ failSpeech: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    await assert.rejects(speech.startListening({}), (error) => error.code === 'listening');
    assert.equal(control.starts, 0);
    assert.equal(control.nativeBusy, false);
    assert.equal(speech.session.ended, true);
  } finally {
    clearBrowser();
  }
});

test('play resolves only after the last tone ends and fails on suspended audio', async () => {
  let control = fakeBrowser({ audio: 'running', autoCue: false });
  try {
    const speech = new Speech();
    const playing = speech.play('choose');
    await tick();
    // The choice cue is one short tone.
    assert.equal(control.oscillators.length, 1);
    let settled = false;
    playing.then(() => { settled = true; });
    await tick(10);
    assert.equal(settled, false);
    control.finishCue();
    assert.equal(await playing, true);
  } finally {
    clearBrowser();
  }
  control = fakeBrowser({ audio: 'suspended' });
  try {
    assert.equal(await new Speech().play('choose'), false);
  } finally {
    clearBrowser();
  }
});

test('regression: a timed-out Listening cue never plays after the audio context resumes', async (t) => {
  const control = fakeBrowser({ audio: 'running', autoCue: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    const playing = speech.play('listening');
    await flush();
    assert.equal(control.oscillators.length, 1);
    const timedOut = control.oscillators[0];
    assert.equal(timedOut.frequency.value, 880);
    assert.equal(timedOut.disconnected, false);
    assert.equal(control.scheduledStops, 1);
    assert.equal(control.immediateStops, 0);

    // Wall time passes while the audio clock is frozen by suspension.
    control.suspendAudio();
    assert.equal(control.advanceAudio(5_000), 0);
    t.mock.timers.tick(80 + 2_000);
    await flush();
    assert.equal(await playing, false);
    assert.equal(timedOut.stoppedImmediately, true);
    assert.equal(timedOut.disconnected, true);
    assert.deepEqual(control.playableOscillators(), []);
    assert.ok(control.gains.every((gain) => gain.disconnected));

    // Resuming the context must not revive the stopped cue.
    control.resumeAudio();
    assert.equal(control.advanceAudio(1_000), 1);
    assert.deepEqual(control.playableOscillators(), []);

    // Late ends from the timed-out cue cannot resolve a newer cue.
    timedOut.onended?.();
    const next = speech.play('listening');
    await flush();
    assert.equal(control.oscillators.length, 2);
    const current = control.oscillators[1];
    assert.equal(control.playableOscillators().length, 1);
    assert.equal(control.playableOscillators()[0], current);
    timedOut.onended?.();
    timedOut.onended?.();
    await flush();
    let settled = false;
    next.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    assert.equal(speech.cueName, 'listening');
    control.finishCue();
    assert.equal(await next, true);
    assert.deepEqual(control.playableOscillators(), []);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('microphone requests share one pending prompt, stop tracks, and propagate refusal', async () => {
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  let calls = 0;
  let release;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => {
          calls += 1;
          return new Promise((resolve) => { release = resolve; });
        },
      },
    },
  });
  try {
    const speech = new Speech();
    const first = speech.requestMicrophone();
    const second = speech.requestMicrophone();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release({ getTracks: () => tracks });
    assert.equal(await first, true);
    assert.deepEqual(tracks.map((track) => track.stopped), [1]);
    await tick();
    const third = speech.requestMicrophone();
    assert.notEqual(third, first);
    assert.equal(calls, 2);
    release({ getTracks: () => [] });
    assert.equal(await third, true);
  } finally {
    delete globalThis.navigator;
  }

  const denied = Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => { throw denied; } } },
  });
  try {
    await assert.rejects(new Speech().requestMicrophone(), /Permission dismissed/u);
  } finally {
    delete globalThis.navigator;
  }
});

test('forceSpeech speaks the status word in screen-reader mode only', async () => {
  const control = fakeBrowser();
  try {
    const speech = new Speech({ outputMode: 'screen-reader' });
    const normal = await speech.announce('An ordinary answer.');
    assert.deepEqual(normal, { spoken: true, interrupted: false, reason: null });
    assert.deepEqual(control.spoken, []);

    const forced = await speech.announce('working', { forceSpeech: true });
    assert.equal(forced.spoken, true);
    assert.deepEqual(control.spoken, ['working']);
  } finally {
    clearBrowser();
  }
});

test('stopping speech settles a chunk that never reports an event', async () => {
  const control = fakeBrowser({ holdSpeech: true });
  try {
    const speech = new Speech();
    const pending = speech.announce('A long introduction to interrupt.');
    await tick();
    assert.equal(control.speechOptions.length, 1);
    assert.equal(speech.speaking, true);
    speech.stopSpeaking('speech');
    assert.equal(control.stopCalls, 1);
    assert.equal(speech.currentChunk, null);
    const outcome = await Promise.race([pending, tick(100).then(() => 'timeout')]);
    assert.deepEqual(outcome, { spoken: false, interrupted: true, reason: 'speech' });
    assert.equal(speech.speaking, false);
    // A late event from the stopped chunk cannot extend or revive output.
    control.speechOptions[0].onEvent({ type: 'end' });
    assert.equal(speech.speaking, false);
    const next = speech.announce('Second message.');
    await tick();
    control.speechOptions[1].onEvent({ type: 'end' });
    assert.deepEqual(await next, { spoken: true, interrupted: false, reason: null });
  } finally {
    clearBrowser();
  }
});

test('the working tone repeats on one timer and stops immediately', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.setWorking(true);
    speech.setWorking(true);
    t.mock.timers.tick(399);
    await flush();
    assert.equal(control.oscillators.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(control.oscillators.length, 2);
    t.mock.timers.tick(1300);
    await flush();
    assert.equal(control.oscillators.length, 4);
    t.mock.timers.tick(1300);
    await flush();
    assert.equal(control.oscillators.length, 6);
    speech.setWorking(false);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(control.oscillators.length, 6);
    speech.setWorking(true);
    t.mock.timers.tick(400);
    await flush();
    assert.equal(control.oscillators.length, 8);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('cancelling the Listening prompt stops speech and never opens the microphone', async () => {
  const control = fakeBrowser({ holdSpeech: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const pending = speech.startListening({});
    await tick();
    assert.equal(control.starts, 0);

    speech.stopListening();
    assert.equal(control.stopCalls, 1);
    assert.deepEqual(await pending, { ready: false, cancelled: true, sessionId: 1 });
    assert.equal(control.starts, 0);
    assert.equal(speech.listening, false);

    // The next request gets its own spoken prompt and recognizer.
    control.ttsHold = false;
    const next = speech.startListening({});
    await tick();
    assert.equal(control.spoken.at(-1), 'Listening');
    assert.equal(control.starts, 1);
    assert.equal((await next).ready, true);
  } finally {
    clearBrowser();
  }
});

test('a newer reply is not stopped by the old session cleanup', async () => {
  const control = fakeBrowser({ holdSpeech: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const pending = speech.startListening({});
    await tick();
    assert.equal(control.starts, 0);

    const answer = speech.announce('An answer replaces the prompt.');
    await tick();
    assert.equal(control.stopCalls, 1);
    assert.equal(control.heldSpeech.length, 1);

    speech.stopListening();
    assert.equal(control.stopCalls, 1);
    assert.equal(control.heldSpeech.length, 1);

    control.releaseSpeech();
    assert.equal((await answer).spoken, true);
    assert.equal((await pending).cancelled, true);
  } finally {
    clearBrowser();
  }
});

test('a late native start after cancellation is aborted again', async () => {
  const control = fakeBrowser({ holdStart: true, holdEnd: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const pending = speech.startListening({ onReady: () => ready.push(1) });
    await tick();
    assert.equal(control.starts, 1);

    speech.stopListening();
    assert.deepEqual(await pending, { ready: false, cancelled: true, sessionId: 1 });
    const aborts = control.aborts;
    control.recognition.onstart?.();
    assert.equal(control.aborts, aborts + 1);
    assert.equal(ready.length, 0);
    assert.equal(speech.listening, false);
    control.releaseEnd();
  } finally {
    clearBrowser();
  }
});

test('waiters after a cancelled session open exactly one new session', async () => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await tick();
    await first;

    speech.stopListening();
    const one = speech.startListening({});
    const two = speech.startListening({});
    await tick();
    assert.equal(control.starts, 1);

    control.releaseEnd();
    await tick();
    await tick();
    assert.equal(control.starts, 2);
    const readyOne = await one;
    const readyTwo = await two;
    assert.equal(readyOne.sessionId, 2);
    assert.deepEqual(readyTwo, readyOne);
  } finally {
    clearBrowser();
  }
});

test('a stop during the handoff wait revokes the pending request', async () => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await tick();
    await first;

    speech.stopListening();
    const pending = speech.startListening({});
    await tick();
    speech.stopListening();
    control.releaseEnd();
    assert.deepEqual(await pending, { ready: false, cancelled: true, sessionId: 1 });
    assert.equal(control.starts, 1);
  } finally {
    clearBrowser();
  }
});

test('a failed native start waits for its delayed end before retrying', async () => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true, failStart: 1 });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const failed = speech.startListening({});
    await assert.rejects(failed, /could not start|recognition/iu);
    // The throwing start may leave the recognizer active; the session must not
    // report ended until Chrome fires onend.
    assert.equal(speech.session.ended, false);

    const retry = speech.startListening({});
    await tick();
    assert.equal(control.starts, 1);
    control.releaseEnd();
    await tick();
    await tick();
    assert.equal(control.starts, 2);
    assert.equal((await retry).ready, true);
  } finally {
    clearBrowser();
  }
});

test('a start timeout waits for the native end before a retry', async (t) => {
  const control = fakeBrowser({ audio: 'running', holdStart: true, holdEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await flush();
    assert.equal(control.starts, 1);
    t.mock.timers.tick(10_000);
    await assert.rejects(first, /did not start listening/iu);

    const retry = speech.startListening({});
    await flush();
    // The timed-out recognizer may still be active, so the retry waits.
    assert.equal(control.starts, 1);
    control.releaseEnd();
    await flush();
    assert.equal(control.starts, 2);

    // The retry's own delayed onstart still becomes a listenable session.
    control.recognition.onstart?.();
    await flush();
    assert.equal((await retry).ready, true);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('a start timeout with no native end retries with a fresh recognizer', async (t) => {
  const control = fakeBrowser({ holdStart: true, holdEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const first = speech.startListening({});
    await flush();
    assert.equal(control.starts, 1);
    t.mock.timers.tick(10_000);
    await assert.rejects(first, /did not start listening/iu);
    t.mock.timers.tick(2_000);
    await flush();
    assert.equal(speech.session.ended, true);

    // The device is still held, so the new instance reports a real start error
    // instead of a reload gate.
    const second = speech.startListening({});
    await assert.rejects(second, /could not start|recognition/iu);
    assert.equal(control.recognitions.length, 2);
    t.mock.timers.tick(2_000);
    await flush();

    // Once the native session finally ends, Alt+Z can listen again.
    control.releaseEnd();
    await flush();
    control.holdStart = false;
    const third = speech.startListening({});
    await flush();
    assert.equal((await third).ready, true);
    // The still-held second attempt never reached native start; the third does.
    assert.equal(control.recognitions.length, 3);
    assert.equal(control.starts, 2);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('a released recognizer that loses its end is abandoned without a reload gate', async (t) => {
  const control = fakeBrowser({ dropEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const pending = speech.startListening({});
    await flush();
    const outcome = await pending;
    assert.equal(outcome.ready, true);

    speech.stopListening();
    assert.equal(control.nativeBusy, false);
    t.mock.timers.tick(2_000);
    await flush();
    assert.equal(speech.session.ended, true);

    const next = speech.startListening({});
    await flush();
    assert.equal(control.recognitions.length, 2);
    assert.deepEqual(await next, { ready: true, sessionId: 2 });
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('repeated stops do not re-abort or revive the session', async () => {
  const control = fakeBrowser({ holdEnd: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    speech.startListening({});
    await tick();
    assert.equal(control.starts, 1);

    speech.stopListening();
    assert.equal(control.aborts, 1);
    speech.stopListening();
    assert.equal(control.aborts, 1);
    assert.equal(speech.inputGeneration, 2);
    control.releaseEnd();
    await tick();
    assert.equal(speech.listening, false);
  } finally {
    clearBrowser();
  }
});

test('handlers captured from an ended session cannot reach the next one', async () => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const firstResults = [];
    const first = speech.startListening({ onResult: (text) => firstResults.push(text) });
    await tick();
    await first;
    const staleStart = control.recognition.onstart;
    const staleResult = control.recognition.onresult;

    speech.stopListening();
    control.releaseEnd();
    await tick();
    const secondResults = [];
    const second = speech.startListening({ onResult: (text) => secondResults.push(text) });
    await tick();
    await second;

    staleStart();
    staleResult(resultEvent('late'));
    await tick();
    assert.deepEqual(firstResults, []);
    assert.deepEqual(secondResults, []);
  } finally {
    clearBrowser();
  }
});
