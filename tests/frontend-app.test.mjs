// Pins: the real page (index.html + app.js) wires the mic pause end to end. A
// session `mic`/`state` event re-renders the Pause button and pill, and while
// paused the capture handler discards frames, so no audio captured during a
// pause (nor the partial chunk before it) is sent after Resume.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDom } from './dom.mjs';
import { base64ToPcm16 } from '../public/audio.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, waitFor, SENTINEL_KEY, CONDUCTOR_A } from './helpers.mjs';

const RATE = 16000; // equals Gemini's input rate, so downsample is the identity
const nodes = []; // AudioWorkletNode stubs, one per startMic
let gemini;
let host;
let app;
let document;
let $;

function stubBrowser(baseUrl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(new URL(u, baseUrl + '/'), o);
  globalThis.EventSource = class { addEventListener() {} };
  globalThis.AudioContext = class {
    sampleRate = RATE;
    currentTime = 0;
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  };
  globalThis.AudioWorkletNode = class {
    port = {};
    constructor() { nodes.push(this); }
    connect() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });
}

before(async () => {
  gemini = await startFakeGemini();
  host = await startFakeHost({ instances: [CONDUCTOR_A] });
  app = await startApp({ gemini, host });
  await app.deps.keyStore.set(SENTINEL_KEY);
  stubBrowser(app.url);
  ({ document } = await loadDom());
  const body = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<body>([\s\S]*)<\/body>/)[1];
  document.body.innerHTML = body;
  $ = (id) => document.getElementById(id);
  await import('../public/app.js');
  await waitFor(() => $('model').options.length > 0, { what: 'model options' });
});

// Disconnect is session.disconnect(), so this also leaves every test's pause cleared.
afterEach(() => $('disconnect').click());

after(async () => {
  await app.stop();
  await host.close();
  await gemini.close();
});

// Clicks Connect and resolves with the live Gemini socket and the mic's worklet node.
async function connectLive() {
  const sockets = gemini.sessions.length;
  const mics = nodes.length;
  $('connect').click();
  await waitFor(() => $('state').textContent === 'live', { what: 'state live' });
  await waitFor(() => nodes.length > mics && nodes.at(-1).port.onmessage, { what: 'mic started' });
  return { socket: await gemini.session(sockets), node: nodes.at(-1) };
}

const frame = (n, value) => ({ data: new Float32Array(n).fill(value) });
const audioChunks = (socket) => socket.messages.filter((m) => m.realtimeInput?.audio).map((m) => [...base64ToPcm16(m.realtimeInput.audio.data)]);

test('the button and pill follow the session: state enables it, mic events toggle it', async () => {
  // Counterfactuals: dropping micControl.render() from onEvent's state branch leaves
  // the button disabled when live; dropping the `mic` branch leaves label,
  // aria-pressed and the pill unchanged after a click (the event would fall
  // through to sessionView.handle, a silent no-op).
  assert.equal($('pause').disabled, true);
  assert.equal($('mic').hidden, true);
  await connectLive();
  assert.equal($('pause').disabled, false);
  assert.equal($('pause').textContent, 'Pause mic');

  $('pause').click();
  assert.equal($('pause').textContent, 'Resume mic');
  assert.equal($('pause').getAttribute('aria-pressed'), 'true');
  assert.equal($('mic').hidden, false);

  $('pause').click();
  assert.equal($('pause').textContent, 'Pause mic');
  assert.equal($('pause').getAttribute('aria-pressed'), 'false');
  assert.equal($('mic').hidden, true);

  $('pause').click();
  $('disconnect').click();
  assert.equal($('pause').disabled, true);
  assert.equal($('pause').textContent, 'Pause mic', 'Disconnect clears the pause');
  assert.equal($('mic').hidden, true);
});

test('while paused the capture handler discards frames, including the partial chunk before the pause', async () => {
  // 100 ms at 16 kHz is 1600 samples; frames of 700 need three pushes per chunk.
  // Counterfactuals: an unconditional chunker.push makes the paused frame count
  // toward the first chunk after Resume; a handler that drops paused frames
  // without clear() leaves the pre-pause partial in the buffer. Either way that
  // chunk would carry the 0.5 / -0.5 samples checked below. sendAudio's own
  // paused gate cannot catch either: the chunk is assembled after Resume.
  const { socket, node } = await connectLive();
  const feed = (n, v) => node.port.onmessage(frame(n, v));

  feed(700, 0.125); feed(700, 0.125); feed(700, 0.125);
  await waitFor(() => audioChunks(socket).length === 1, { what: 'first chunk' });

  feed(700, 0.5); // partial chunk held when the pause starts
  $('pause').click();
  await socket.next((m) => m.realtimeInput?.audioStreamEnd);
  feed(700, -0.5); // captured while paused
  $('pause').click();
  feed(700, 0.25); feed(700, 0.25); feed(700, 0.25);

  await waitFor(() => audioChunks(socket).length === 2, { what: 'chunk after resume' });
  const [, afterResume] = audioChunks(socket);
  assert.equal(afterResume.length, 2100);
  assert.ok(afterResume.every((x) => x === 8192), 'only post-resume samples (0.25 -> 8192) were sent');
  assert.equal(socket.messages.filter((m) => m.realtimeInput?.audioStreamEnd).length, 1);
});
