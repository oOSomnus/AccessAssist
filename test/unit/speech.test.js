import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOUND_CUES,
  Speech,
  localRecognitionSupported,
  spokenSites,
  voiceSetupView,
} from '../../extension/speech.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function resultEvent(transcript, final = true) {
  const item = [{ transcript, confidence: 1 }];
  item.isFinal = final;
  return { results: [item], resultIndex: 0 };
}

function cumulativeEvent(items) {
  const results = items.map(({ transcript, final = true }) => {
    const item = [{ transcript, confidence: 1 }];
    item.isFinal = final;
    return item;
  });
  return { results, resultIndex: 0 };
}

function fakeLog() {
  const entries = [];
  return {
    entries,
    getAttribute(name) { return name === 'role' ? 'log' : null; },
    append(node) { entries.push(node); },
    get textContent() { return entries.map((node) => node.textContent).join(''); },
    set textContent(value) {
      entries.length = 0;
      if (value) entries.push({ textContent: String(value) });
    },
    ownerDocument: {
      createElement() { return { textContent: '' }; },
    },
  };
}

function fakeBrowser({
  status = 'available',
  install = true,
  audio = 'running',
  resume = false,
  holdStart = false,
  holdEnd = false,
  dropEnd = false,
  failStart = 0,
  autoCue = true,
  gum = 'grant',
  echo = 'all',
  platform = 'linux',
} = {}) {
  const control = {
    available: status,
    installCalls: [],
    starts: 0,
    startArgs: [],
    gum,
    echo,
    platform,
    gumCalls: 0,
    gumOptions: [],
    gumResolvers: [],
    tracksStopped: 0,
    lastEcho: null,
    lastTrack: null,
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
    holdStart,
    releaseEnd() {
      const recognition = control.activeRecognition ?? control.recognition;
      if (!recognition) return;
      recognition.active = false;
      control.nativeBusy = false;
      control.activeRecognition = null;
      queueMicrotask(() => recognition.onend?.());
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
      const values = [];
      const gain = {
        gain: {
          values,
          setValueAtTime(value) { values.push(value); },
          exponentialRampToValueAtTime(value) { values.push(value); },
        },
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
  control.makeStream = () => {
    const track = {
      kind: 'audio',
      readyState: 'live',
      onended: null,
      stop() {
        control.tracksStopped += 1;
        this.readyState = 'ended';
      },
      getSettings: () => ({ echoCancellation: control.echo }),
    };
    control.lastTrack = track;
    control.lastEcho = control.echo;
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  control.releaseGum = () => {
    const resolve = control.gumResolvers.shift();
    if (resolve) resolve(control.makeStream());
  };
  control.getUserMedia = async (constraints) => {
    control.gumCalls += 1;
    control.gumOptions.push(constraints);
    if (control.gum === 'pending') {
      return new Promise((resolve) => { control.gumResolvers.push(resolve); });
    }
    if (control.gum === 'deny') {
      throw Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
    }
    if (control.gum === 'missing') {
      throw Object.assign(new Error('No microphone'), { name: 'NotFoundError' });
    }
    if (control.gum === 'constraint') {
      throw Object.assign(new Error('Constraints cannot be satisfied'), { name: 'OverconstrainedError' });
    }
    return control.makeStream();
  };
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  }
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: control.getUserMedia },
  });
  globalThis.SpeechRecognition = FakeRecognition;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.chrome = {
    runtime: {
      getPlatformInfo: async () => ({ os: control.platform }),
    },
  };
  return control;
}

function clearBrowser() {
  delete globalThis.SpeechRecognition;
  delete globalThis.AudioContext;
  delete globalThis.chrome;
  if (globalThis.navigator) delete globalThis.navigator.mediaDevices;
}

test('spoken sites shorten every HTTPS host without a leading www', () => {
  const origins = [
    'https://www.google.com',
    'https://example.com',
    'https://docs.example.com:8443',
    'http://example.com',
    'https://www.example.com',
    'https://example.com/',
    'https://example.com/path?q=1',
    'https://www.example.com:9443/path',
    'not an origin',
  ];
  assert.deepEqual(spokenSites(origins), [
    'google.com',
    'example.com',
    'docs.example.com:8443',
    'http://example.com',
    'example.com',
    'example.com',
    'example.com',
    'example.com:9443',
    'not an origin',
  ]);
  // A www and non-www collision still speaks both as the same short host;
  // the real origins remain distinct for consent and requests.
  assert.deepEqual(spokenSites(['https://www.example.com', 'https://example.com']), [
    'example.com',
    'example.com',
  ]);
  const snapshot = [...origins];
  spokenSites(snapshot);
  assert.deepEqual(snapshot, origins);
  assert.deepEqual(spokenSites(null), []);
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

test('the isolated live track feeds local recognition and is released after one final', async () => {
  const control = fakeBrowser({ audio: 'running', autoCue: false });
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
    assert.deepEqual(control.gumOptions, [{ audio: { echoCancellation: { exact: 'all' } } }]);
    assert.equal(control.starts, 1);
    const track = control.startArgs[0];
    assert.equal(track.kind, 'audio');
    assert.equal(control.lastEcho, 'all');

    control.finishCue();
    assert.deepEqual(await pending, { ready: true, sessionId: 1 });

    control.recognition.onresult(resultEvent('one', false));
    assert.deepEqual(results, []);
    control.recognition.onresult(resultEvent('one'));
    control.recognition.onresult(resultEvent('one'));
    await tick(3005);
    await tick();
    assert.equal(results.length, 1);
    assert.equal(results[0][0], 'one');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'final');
    assert.equal(track.readyState, 'ended');
    assert.equal(track.onended, null);
    assert.equal(control.recognition.active, false);
  } finally {
    clearBrowser();
  }
});

test('a non-isolatable platform refuses the track instead of falling back to the default microphone', async () => {
  const control = fakeBrowser({ platform: 'android' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    await assert.rejects(speech.startListening({}), (error) => error.code === 'unsupported-input');
    assert.equal(control.gumCalls, 0);
    assert.equal(control.starts, 0);
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
    assert.equal(control.oscillators.length, 2);
    assert.equal(control.oscillators[0].frequency.value, 880);
    assert.equal(control.oscillators[1].frequency.value, 880);
    assert.ok(Math.abs(control.oscillators[0].stopAt - 0.19) < 1e-9);
    assert.ok(Math.abs(control.oscillators[1].startAt - 0.27) < 1e-9);
    assert.equal(Math.max(...control.gains[0].gain.values), 0.25);
    assert.equal(Math.max(...control.gains[1].gain.values), 0.25);
    assert.deepEqual(ready, []);

    control.recognition.onresult(resultEvent('one'));
    await tick();
    assert.deepEqual(results, []);

    control.finishCue();
    const outcome = await pending;
    assert.deepEqual(outcome, { ready: true, sessionId: 1 });
    assert.equal(ready.length, 1);
    assert.equal(ready[0].cuePlayed, true);

    control.recognition.onresult(cumulativeEvent([
      { transcript: 'ignored' },
      { transcript: 'one' },
    ]));
    await tick(3005);
    await tick();
    assert.deepEqual(results, ['one']);
  } finally {
    clearBrowser();
  }
});

test('an unavailable start tone stops the live input instead of listening silently', async () => {
  const control = fakeBrowser({ audio: 'suspended' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const results = [];
    await assert.rejects(
      speech.startListening({
        onReady: (info) => ready.push(info),
        onResult: (text) => results.push(text),
      }),
      (error) => error.code === 'listening',
    );
    assert.equal(control.starts, 1);
    assert.deepEqual(control.oscillators, []);
    assert.equal(ready.length, 0);
    assert.equal(control.tracksStopped, 1);
    control.recognition.onresult?.(resultEvent('help'));
    await tick();
    assert.deepEqual(results, []);
    assert.equal(speech.session.ended, true);
  } finally {
    clearBrowser();
  }
});

test('refusing echo cancellation all or an ended track stops before native start', async () => {
  for (const setup of [
    { gum: 'constraint' },
    { echo: true },
    { trackEnded: true },
  ]) {
    const control = fakeBrowser(setup);
    if (setup.trackEnded) {
      const makeStream = control.makeStream;
      control.makeStream = () => {
        const stream = makeStream();
        stream.getAudioTracks()[0].readyState = 'ended';
        return stream;
      };
    }
    try {
      const speech = new Speech();
      speech.localAvailable = true;
      await assert.rejects(speech.startListening({}), (error) => error.code === 'audio-capture');
      assert.equal(control.starts, 0, JSON.stringify(setup));
      assert.equal(control.tracksStopped, setup.trackEnded || setup.echo === true ? 1 : 0, JSON.stringify(setup));
    } finally {
      clearBrowser();
    }
  }
});

test('a capture permission refusal keeps its own recovery code', async () => {
  const control = fakeBrowser({ gum: 'deny' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    await assert.rejects(speech.startListening({}), (error) => error.code === 'not-allowed');
    assert.equal(control.starts, 0);
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
    assert.equal(control.oscillators.length, 2);

    speech.stopListening();
    assert.deepEqual(await first, { ready: false, cancelled: true, sessionId: 1 });
    const staleCue = control.oscillators[0];
    control.releaseEnd();
    await tick();

    const second = speech.startListening({});
    await tick();
    await tick();
    assert.equal(control.oscillators.length, 4);
    const secondToken = speech.session.readyCueToken;
    assert.ok(secondToken);

    // A late callback from the cancelled cue must not end the new one.
    staleCue.onended?.();
    await tick(10);
    assert.equal(speech.session.readyDelivered, false);
    assert.equal(speech.session.readyCueToken, secondToken);

    control.oscillators[3].onended?.();
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

test('stopping while the isolated stream is pending never starts and releases a late stream', async () => {
  const control = fakeBrowser({ gum: 'pending' });
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
    assert.equal(control.gumCalls, 1);
    speech.stopListening();
    const outcome = await pending;
    assert.equal(outcome.ready, false);
    assert.equal(outcome.cancelled, true);
    control.releaseGum();
    await tick();
    assert.equal(control.starts, 0);
    assert.equal(control.tracksStopped, 1);
    assert.deepEqual(results, []);
    assert.equal(ends.length, 0);
    assert.equal(speech.listening, false);
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
    assert.equal(Math.max(...control.gains[0].gain.values), 0.15);
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
    assert.equal(control.oscillators.length, 2);
    const timedOut = control.oscillators[0];
    assert.equal(timedOut.frequency.value, 880);
    assert.equal(timedOut.disconnected, false);
    assert.equal(control.scheduledStops, 2);
    assert.equal(control.immediateStops, 0);

    // Wall time passes while the audio clock is frozen by suspension.
    control.suspendAudio();
    assert.equal(control.advanceAudio(5_000), 0);
    t.mock.timers.tick(440 + 2_000);
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
    assert.equal(control.oscillators.length, 4);
    const current = control.oscillators[3];
    assert.equal(control.playableOscillators().length, 2);
    assert.equal(control.playableOscillators().at(-1), current);
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

test('screen-reader delivery appends every message to the log and never speaks', async () => {
  const control = fakeBrowser();
  const statusEl = fakeLog();
  const alertEl = { textContent: '' };
  try {
    const speech = new Speech();
    speech.attach({ statusEl, alertEl });
    const normal = await speech.announce('An ordinary answer.');
    assert.deepEqual(normal, { delivered: true, interrupted: false, reason: null });
    assert.deepEqual(statusEl.entries.map((entry) => entry.textContent), ['An ordinary answer.']);

    const status = await speech.announce('working');
    assert.deepEqual(status, { delivered: true, interrupted: false, reason: null });
    // Identical messages remain distinct additions so a screen reader reads
    // each one instead of seeing an unchanged region.
    await speech.announce('working');
    assert.deepEqual(statusEl.entries.map((entry) => entry.textContent), [
      'An ordinary answer.',
      'working',
      'working',
    ]);

    const alert = await speech.announce('Failed.', { alert: true });
    assert.equal(alert.delivered, true);
    assert.equal(alertEl.textContent, 'Failed.');
    assert.equal(statusEl.entries.length, 3);

    speech.clearStatus();
    assert.equal(statusEl.entries.length, 0);
  } finally {
    clearBrowser();
  }
});

test('a single-value status target still shows only the latest message', async () => {
  fakeBrowser();
  const statusEl = { textContent: '' };
  try {
    const speech = new Speech();
    speech.attach({ statusEl, alertEl: { textContent: '' } });
    await speech.announce('First.');
    await speech.announce('Second.');
    assert.equal(statusEl.textContent, 'Second.');
  } finally {
    clearBrowser();
  }
});

test('repeating the same alert text clears the channel first', async () => {
  fakeBrowser();
  let value = '';
  let clears = 0;
  const alertEl = {
    get textContent() { return value; },
    set textContent(next) {
      if (next === '') clears += 1;
      value = String(next);
    },
  };
  try {
    const speech = new Speech();
    speech.attach({ statusEl: { textContent: '' }, alertEl });
    await speech.announce('I heard: yes', { alert: true });
    await speech.announce('I heard: yes', { alert: true });
    assert.equal(clears, 2);
    assert.equal(value, 'I heard: yes');
  } finally {
    clearBrowser();
  }
});

test('a missing live target is not delivered and an empty announcement is a no-op', async () => {
  fakeBrowser();
  try {
    const speech = new Speech();
    assert.deepEqual(await speech.announce('Nowhere to write.'), {
      delivered: false,
      interrupted: false,
      reason: null,
    });
    assert.deepEqual(await speech.announce('   '), {
      delivered: true,
      interrupted: false,
      reason: null,
    });
  } finally {
    clearBrowser();
  }
});

test('fifteen seconds of silence ends the authorized command once', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ends = [];
    const pending = speech.startListening({ onEnd: (info) => ends.push(info) });
    await flush();
    assert.deepEqual(await pending, { ready: true, sessionId: 1 });

    t.mock.timers.tick(14_999);
    await flush();
    assert.deepEqual(ends, []);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-speech');
    assert.equal(control.tracksStopped, 1);
    const starts = control.starts;
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(control.starts, starts);
    assert.equal(speech.session.ended, true);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('an early native no-speech restarts the same command without another prompt', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const ready = [];
    const ends = [];
    const pending = speech.startListening({
      onReady: (info) => ready.push(info),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;
    const staleResult = control.recognition.onresult;

    t.mock.timers.tick(5_000);
    await flush();
    control.recognition.onerror({ error: 'no-speech' });
    control.releaseEnd();
    await flush();
    assert.equal(control.gumCalls, 1);
    assert.equal(control.starts, 1);
    assert.equal(control.oscillators.length, 2);

    t.mock.timers.tick(250);
    await flush();
    assert.equal(control.starts, 2);
    assert.equal(control.recognitions.length, 2);
    assert.equal(control.oscillators.length, 2);
    assert.equal(ready.length, 1);

    staleResult(resultEvent('late'));
    await flush();
    assert.equal(speech.session.segments.length, 0);

    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-speech');
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('final segments join across a two-second pause and interim text never executes', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;

    control.recognition.onresult(cumulativeEvent([{ transcript: 'Read the first' }]));
    t.mock.timers.tick(1_500);
    await flush();
    assert.deepEqual(results, []);

    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph', final: false },
    ]));
    t.mock.timers.tick(1_999);
    await flush();
    assert.deepEqual(results, []);

    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph' },
    ]));
    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph' },
    ]));
    t.mock.timers.tick(1_999);
    await flush();
    assert.deepEqual(results, []);

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(results, ['Read the first paragraph']);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'final');
    assert.equal(control.tracksStopped, 1);
    assert.equal(control.recognitions.length, 1);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('a live interim after a final keeps the pause from firing', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;

    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph', final: false },
    ]));
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, []);
    assert.equal(control.tracksStopped, 0);

    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph' },
    ]));
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, ['Read the first paragraph']);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'final');
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('identical words at different finalized indexes are kept', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const pending = speech.startListening({ onResult: (text) => results.push(text) });
    await flush();
    await pending;
    control.recognition.onresult(cumulativeEvent([
      { transcript: 'very' },
      { transcript: 'very' },
    ]));
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, ['very very']);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('a final result after stop is included once before native end', async (t) => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;

    control.recognition.onresult(resultEvent('Read the first'));
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, []);
    control.recognition.onresult(cumulativeEvent([
      { transcript: 'Read the first' },
      { transcript: 'paragraph' },
    ]));
    await flush();
    control.releaseEnd();
    await flush();
    assert.deepEqual(results, ['Read the first paragraph']);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'final');
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('a missing native end after stop delivers only finalized text', async (t) => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const pending = speech.startListening({ onResult: (text) => results.push(text) });
    await flush();
    await pending;

    control.recognition.onresult(resultEvent('Read this'));
    t.mock.timers.tick(2_000);
    await flush();
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, ['Read this']);
    assert.equal(control.tracksStopped, 1);
    assert.equal(speech.session.ended, true);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('only interim text finishes with no request instead of an instruction', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;

    control.recognition.onresult(resultEvent('unfinished thought', false));
    control.releaseEnd();
    await flush();
    t.mock.timers.tick(2_000);
    await flush();
    assert.deepEqual(results, []);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-speech');
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('the sixty-second command cap cancels without submitting partial text', async (t) => {
  const control = fakeBrowser({ audio: 'running' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const ends = [];
    const pending = speech.startListening({
      onResult: (text) => results.push(text),
      onEnd: (info) => ends.push(info),
    });
    await flush();
    await pending;

    control.recognition.onresult(resultEvent('keep talking', false));
    t.mock.timers.tick(59_999);
    await flush();
    assert.deepEqual(ends, []);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(results, []);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'timeout');
    assert.equal(control.tracksStopped, 1);
  } finally {
    t.mock.timers.reset();
    clearBrowser();
  }
});

test('cancelling during final flush drops the pending result', async (t) => {
  const control = fakeBrowser({ audio: 'running', holdEnd: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const results = [];
    const pending = speech.startListening({ onResult: (text) => results.push(text) });
    await flush();
    await pending;

    control.recognition.onresult(resultEvent('Do not use this'));
    t.mock.timers.tick(2_000);
    await flush();
    speech.stopListening();
    control.releaseEnd();
    await flush();
    assert.deepEqual(results, []);
    assert.equal(speech.session.ended, true);
    assert.equal(speech.session.cancelled, true);
  } finally {
    t.mock.timers.reset();
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

test('cancelling before capture resolves leaves no live input and the next request listens once', async () => {
  const control = fakeBrowser({ gum: 'pending', audio: 'running' });
  try {
    const speech = new Speech();
    speech.localAvailable = true;
    const pending = speech.startListening({});
    await tick();
    assert.equal(control.gumCalls, 1);

    speech.stopListening();
    assert.deepEqual(await pending, { ready: false, cancelled: true, sessionId: 1 });
    assert.equal(control.starts, 0);
    assert.equal(speech.listening, false);

    // The cancelled request still receives its stream and must release it.
    control.releaseGum();
    await tick();
    assert.equal(control.starts, 0);
    assert.equal(control.tracksStopped, 1);
    assert.equal(control.lastTrack.readyState, 'ended');

    control.gum = 'grant';
    const next = speech.startListening({});
    await tick();
    assert.equal(control.starts, 1);
    assert.equal(control.startArgs.at(-1).kind, 'audio');
    assert.equal((await next).ready, true);
  } finally {
    clearBrowser();
  }
});

test('a newer announcement is delivered without reviving the old capture', async () => {
  const control = fakeBrowser({ gum: 'pending' });
  const statusEl = fakeLog();
  try {
    const speech = new Speech();
    speech.attach({ statusEl, alertEl: { textContent: '' } });
    speech.localAvailable = true;
    const pending = speech.startListening({});
    await tick();
    assert.equal(control.gumCalls, 1);

    const answer = await speech.announce('An answer replaces the capture.');
    assert.equal(answer.delivered, true);
    assert.deepEqual(statusEl.entries.map((entry) => entry.textContent), [
      'An answer replaces the capture.',
    ]);

    assert.equal((await pending).cancelled, true);
    control.releaseGum();
    await tick();
    assert.equal(control.starts, 0);
    assert.equal(control.tracksStopped, 1);
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

    // Once the native session finally ends, the next listen request can start.
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

test('voice setup view keeps every status sentence', () => {
  const base = { local: 'available', mic: 'granted', ready: false, preparing: false, failed: false, listen: 'Press X to listen' };
  const cases = [
    [{ ...base, surface: 'panel' }, 'Speech is ready. Press X to listen.'],
    [{ ...base, surface: 'panel', failed: true }, 'Voice is not ready. Choose Retry to try again.'],
    [{ ...base, surface: 'panel', mic: 'prompt' }, 'Voice needs microphone permission. Choose Prepare voice to start.'],
    [{ ...base, surface: 'panel', mic: 'denied' }, 'Microphone access is denied. Allow it in Chrome site settings and system settings, then choose Retry.'],
    [{ ...base, surface: 'panel', local: 'unavailable' }, 'This Chrome cannot recognize speech on this device. Choose Retry after enabling local speech.'],
    [{ ...base, surface: 'panel', local: 'error' }, 'Chrome could not check the English speech pack. Choose Retry.'],
    [{ ...base, surface: 'panel', local: 'downloadable' }, 'The English speech pack is not ready. Choose Prepare voice to start.'],
    [{ ...base, surface: 'panel', local: 'downloading' }, 'Chrome is downloading the English speech pack. Voice will be ready when it finishes.'],
    [{ ...base, surface: 'panel', preparing: true, mic: 'prompt' }, 'Chrome is preparing the English speech pack and will ask for the microphone.'],
    [{ ...base, surface: 'setup', ready: true }, 'Microphone access is granted. Speech is ready on this device.'],
    [{ ...base, surface: 'setup' }, 'Waiting for the English speech pack.'],
    [{ ...base, surface: 'setup', mic: 'prompt' }, 'Press Prepare voice to check the microphone and prepare speech.'],
    [{ ...base, surface: 'setup', mic: 'prompt', failed: true }, 'Voice is not ready. Choose Retry to try again.'],
    [{ ...base, surface: 'setup', mic: 'denied' }, 'Microphone access is denied. Allow it in Chrome site settings and system settings, then choose Retry.'],
    [{ ...base, surface: 'setup', local: 'unavailable' }, 'This Chrome cannot recognize speech on this device.'],
    [{ ...base, surface: 'setup', local: 'error' }, 'Chrome could not check the English speech pack. Choose Retry.'],
    [{ ...base, surface: 'setup', local: 'downloadable' }, 'Chrome needs the English speech pack. Choose Prepare voice to start.'],
    [{ ...base, surface: 'setup', local: 'downloading' }, 'Chrome is downloading the English speech pack. Voice will be ready when it finishes.'],
    [{ ...base, surface: 'setup', preparing: true }, 'Chrome is preparing the English speech pack and will ask for the microphone. Allow it when Chrome asks.'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(voiceSetupView(input).status, expected, JSON.stringify(input));
  }
});

test('a downloading pack says so and hides Prepare voice', () => {
  const base = { local: 'available', mic: 'granted', ready: false, preparing: false, failed: false, listen: 'Press X to listen' };
  const downloading = 'Chrome is downloading the English speech pack. Voice will be ready when it finishes.';
  for (const surface of ['panel', 'setup']) {
    const busy = voiceSetupView({ ...base, surface, local: 'downloading' });
    assert.equal(busy.status, downloading, surface);
    assert.equal(busy.startHidden, true, surface);
    const ready = voiceSetupView({ ...base, surface, local: 'downloadable' });
    assert.match(ready.status, /Choose Prepare voice/u, surface);
    assert.equal(ready.startHidden, false, surface);
    assert.equal(ready.startLabel, '1 Prepare voice', surface);
  }
});

test('voice setup view hides the right controls', () => {
  const base = { local: 'available', mic: 'granted', ready: false, preparing: false, failed: false, listen: 'Press X to listen' };
  assert.deepEqual(voiceSetupView({ ...base, surface: 'panel', ready: true }), { sectionHidden: true });
  assert.equal(voiceSetupView({ ...base, surface: 'setup', local: 'downloading' }).startHidden, true);
  assert.equal(voiceSetupView({ ...base, surface: 'setup', local: 'downloading' }).returnHidden, true);
  const retry = voiceSetupView({ ...base, surface: 'panel', local: 'downloading', failed: true });
  assert.equal(retry.startHidden, false);
  assert.equal(retry.startLabel, '1 Retry');
  const busy = voiceSetupView({ ...base, surface: 'panel', preparing: true });
  assert.equal(busy.startHidden, true);
  assert.equal(busy.startLabel, '1 Prepare voice');
  assert.equal(voiceSetupView({ ...base, surface: 'setup', ready: true }).returnHidden, false);
});
