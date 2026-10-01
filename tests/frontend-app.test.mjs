// Pins: the real page (index.html + app.js) wires the mic pause end to end. A
// session `mic`/`state` event re-renders the Pause button and pill, and while
// paused the capture handler discards frames, so no audio captured during a
// pause (nor the partial chunk before it) is sent after Resume. It also pins
// the mic lifecycle: at most one capture per session however start, resume and
// stop interleave with the pending getUserMedia / worklet load, and every
// capture a stop or failure leaves behind is released. It also pins the single
// Connect / Disconnect button and the new-session divider.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDom } from './dom.mjs';
import { base64ToPcm16 } from '../public/audio.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, waitFor, SENTINEL_KEY, CONDUCTOR_A } from './helpers.mjs';

const RATE = 16000; // equals Gemini's input rate, so downsample is the identity
const nodes = []; // AudioWorkletNode stubs, one per capture built
const streams = []; // fake MediaStreams handed out by the default getUserMedia
const settleOnTeardown = []; // deferreds a test left pending, with the value to settle them with
const defaultGum = async () => fakeStream();
const defaultLoadModule = async () => {};
let gum = defaultGum;
let loadModule = defaultLoadModule;
let gumCalls = 0;
let moduleCalls = 0;
let tokenGate = null; // a promise api/token waits on, set by holdTokenMint
let gemini;
let host;
let app;
let document;
let $;

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { tracks: [track], getTracks() { return this.tracks; } };
  streams.push(stream);
  return stream;
}

// A promise a test settles by hand; `fallback` builds the value teardown resolves it with.
function deferred(fallback) {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  settleOnTeardown.push({ d, fallback });
  return d;
}

function stubBrowser(baseUrl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (u === 'api/token' && tokenGate) {
      // A real fetch rejects when its signal aborts.
      const aborted = new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(o.signal.reason)));
      await Promise.race([tokenGate, aborted]);
    }
    return realFetch(new URL(u, baseUrl + '/'), o);
  };
  globalThis.EventSource = class { addEventListener() {} };
  globalThis.AudioContext = class {
    sampleRate = RATE;
    currentTime = 0;
    audioWorklet = { addModule: () => { moduleCalls++; return loadModule(); } };
    resume = async () => {};
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  };
  globalThis.AudioWorkletNode = class {
    port = {};
    constructor() { nodes.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: (c) => { gumCalls++; return gum(c); } } },
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
// Then no start is left pending: settle what a test abandoned and let it finish.
afterEach(async () => {
  if ($('connect').textContent === 'Disconnect') $('connect').click();
  gemini.setConnectMode('ok');
  gemini.setMintFailure(null);
  tokenGate = null;
  gum = defaultGum;
  loadModule = defaultLoadModule;
  for (const { d, fallback } of settleOnTeardown.splice(0)) d.resolve(fallback?.());
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await app.stop();
  await host.close();
  await gemini.close();
});

// Clicks the button, which must read Disconnect.
function hangUp() {
  assert.equal($('connect').textContent, 'Disconnect');
  $('connect').click();
}

// Makes api/token wait until the returned `release` is called.
function holdTokenMint() {
  const d = deferred();
  tokenGate = d.promise;
  return () => { tokenGate = null; d.resolve(); };
}

// Clicks Connect and resolves with the live Gemini socket and the mic's worklet node.
async function connectLive() {
  const sockets = gemini.sessions.length;
  const mics = nodes.length;
  assert.equal($('connect').textContent, 'Connect');
  $('connect').click();
  await waitFor(() => $('state').textContent === 'live', { what: 'state live' });
  await waitFor(() => nodes.length > mics && nodes.at(-1).port.onmessage, { what: 'mic started' });
  return { socket: await gemini.session(sockets), node: nodes.at(-1) };
}

// Clicks Connect and resolves with the Gemini socket once the state is live,
// without waiting for a mic (its getUserMedia may be held open by the test).
async function connectPending() {
  const sockets = gemini.sessions.length;
  assert.equal($('connect').textContent, 'Connect');
  $('connect').click();
  await waitFor(() => $('state').textContent === 'live', { what: 'state live' });
  return gemini.session(sockets);
}

// Makes Gemini hand the session over (handle, then goAway) and resolves with the
// resumed socket once the page is live again.
async function resume(socket) {
  const next = gemini.sessions.length;
  socket.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  socket.send({ goAway: { timeLeft: '5s' } });
  const resumed = await gemini.session(next);
  await waitFor(() => $('state').textContent === 'live', { what: 'state live after resume' });
  return resumed;
}

const mints = () => gemini.requests.filter((r) => r.url === '/v1beta/auth_tokens').length;
const dividers = () => $('transcript').querySelectorAll('.divider');
const transcriptHas = (text) => $('transcript').textContent.includes(text);
const startedAfter = (mics) => waitFor(() => nodes.length > mics && nodes.at(-1).port.onmessage, { what: 'mic started' });

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
  hangUp();
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

test('a resume while getUserMedia is pending starts no second capture', async () => {
  // Pins: at most one getUserMedia and one worklet node per session. Counterfactual:
  // without claiming the mic before the first await, the `live` the resume emits
  // finds no mic yet and starts a second capture, so every frame is sent twice.
  const d = deferred(fakeStream);
  gum = () => d.promise;
  const gums = gumCalls;
  const mics = nodes.length;
  const s0 = await connectPending();
  const s1 = await resume(s0);
  assert.equal(gumCalls - gums, 1, 'the resume did not ask for the microphone again');

  d.resolve(fakeStream());
  await startedAfter(mics);
  assert.equal(nodes.length - mics, 1);
  for (const node of nodes.slice(mics)) for (let i = 0; i < 3; i++) node.port.onmessage(frame(700, 0.125));
  await waitFor(() => audioChunks(s1).length >= 1, { what: 'audio chunk' });
  assert.equal(audioChunks(s1).length, 1);
});

test('disconnect while getUserMedia is pending releases the capture once it resolves, and the next connect starts a fresh one', async () => {
  // Pins: a stop that lands mid-start leaks nothing, builds no node, and does not
  // wedge later starts. Counterfactual: if the abandoned start still adopts its
  // capture, the track stays live on an idle page and the next Connect finds a
  // mic and starts none.
  const d = deferred(fakeStream);
  gum = () => d.promise;
  const mics = nodes.length;
  const before = streams.length;
  await connectPending();
  hangUp();

  d.resolve(fakeStream());
  await waitFor(() => streams.length > before && streams.at(-1).tracks[0].stopped, { what: 'abandoned track stopped' });
  assert.equal(nodes.length - mics, 0, 'the abandoned start builds no node');

  gum = defaultGum;
  await connectLive();
  assert.equal(nodes.length - mics, 1);
});

test('disconnect while the worklet module loads stops the track once it resolves', async () => {
  // Pins: a stop landing between getUserMedia and the node build releases the
  // stream and the start builds no node. Counterfactual: a start that ignores the
  // stop keeps the track live and builds a node on an idle page.
  const d = deferred();
  loadModule = () => d.promise;
  const mics = nodes.length;
  const modules = moduleCalls;
  const before = streams.length;
  await connectPending();
  await waitFor(() => moduleCalls > modules, { what: 'worklet load started' });
  hangUp();

  d.resolve();
  await waitFor(() => streams.length > before && streams.at(-1).tracks[0].stopped, { what: 'track stopped' });
  assert.equal(nodes.length - mics, 0, 'the abandoned start builds no node');
});

test('disconnect while the worklet module never loads stops the track without waiting for it', async () => {
  // Pins: once Disconnect runs, every track a start already acquired is stopped
  // at once, whether or not that start ever settles. Counterfactual: a stop that
  // can only release a finished capture leaves the microphone indicator on for as
  // long as the load stays pending.
  loadModule = () => new Promise(() => {});
  const modules = moduleCalls;
  const before = streams.length;
  await connectPending();
  await waitFor(() => moduleCalls > modules, { what: 'worklet load started' });
  assert.equal(streams.length - before, 1);
  hangUp();
  assert.equal(streams.at(-1).tracks[0].stopped, true);
});

test('disconnect stops a completed capture: the track is stopped and the node released', async () => {
  // Pins: Disconnect releases a finished capture in full. Counterfactual: a release
  // that keeps the node's message handler or leaves it connected lets the next
  // Connect's capture run alongside it, sending every frame twice.
  const { node } = await connectLive();
  hangUp();
  assert.equal(streams.at(-1).tracks[0].stopped, true);
  assert.equal(node.port.onmessage, null);
  assert.equal(node.disconnected, true);
});

test('a start abandoned while getUserMedia is pending stops its track even if the worklet never loads', async () => {
  // Pins: the staleness check right after getUserMedia. Counterfactual: without it
  // the start goes on to await a load that never settles, holding the track live.
  const d = deferred(fakeStream);
  gum = () => d.promise;
  loadModule = () => new Promise(() => {});
  const before = streams.length;
  await connectPending();
  hangUp();

  d.resolve(fakeStream());
  await waitFor(() => streams.length > before && streams.at(-1).tracks[0].stopped, { what: 'abandoned track stopped' });
});

test('a rejected getUserMedia reports the error and the next live starts the mic', async () => {
  // Pins: a refused microphone is reported and does not wedge later starts.
  // Counterfactual: a claim that survives the rejection blocks the resume's start.
  gum = () => Promise.reject(new Error('Permission denied'));
  const mics = nodes.length;
  const s0 = await connectPending();
  await waitFor(() => transcriptHas('Microphone: Permission denied'), { what: 'error in the transcript' });

  gum = defaultGum;
  await resume(s0);
  await startedAfter(mics);
});

test('a failed worklet load stops the stream and does not wedge', async () => {
  // Pins: tracks are stopped on any failure after getUserMedia resolved.
  // Counterfactual: without the cleanup the microphone stays open after the error.
  loadModule = () => Promise.reject(new Error('module failed'));
  const mics = nodes.length;
  const before = streams.length;
  const s0 = await connectPending();
  await waitFor(() => transcriptHas('Microphone: module failed'), { what: 'error in the transcript' });
  assert.equal(streams.length - before, 1);
  assert.equal(streams.at(-1).tracks[0].stopped, true);

  loadModule = defaultLoadModule;
  await resume(s0);
  await startedAfter(mics);
});

test("a stale start's rejection does not clear the current one", async () => {
  // Pins: a rejected start clears the claim only if it is still the current one.
  // A regression guard for the `mic === claim` check, not failing-state evidence:
  // it also passes on the code before the claim existed. Counterfactual: an
  // unconditional clear on rejection lets A's late failure erase B's claim, so
  // the resume starts a third capture.
  const a = deferred();
  const b = deferred(fakeStream);
  const queue = [a, b];
  gum = () => queue.shift().promise;
  const gums = gumCalls;
  const mics = nodes.length;
  await connectPending();
  hangUp();
  const s1 = await connectPending();

  a.reject(new Error('A denied'));
  await waitFor(() => transcriptHas('Microphone: A denied'), { what: 'A reported' });
  b.resolve(fakeStream());
  await startedAfter(mics);
  await resume(s1);
  await new Promise((r) => setImmediate(r));
  assert.equal(gumCalls - gums, 2, 'the resume did not start a third capture');
  const live = nodes.slice(mics).filter((n) => n.port.onmessage && !n.disconnected);
  assert.equal(live.length, 1);
});

test('a pause during a pending start holds once the capture starts', async () => {
  // Pins: pause behavior is unchanged mid-start. Counterfactual: a capture that
  // starts unpaused after a pause would send what it hears while the session is paused.
  const d = deferred(fakeStream);
  gum = () => d.promise;
  const mics = nodes.length;
  const socket = await connectPending();
  $('pause').click();
  await socket.next((m) => m.realtimeInput?.audioStreamEnd);

  d.resolve(fakeStream());
  await startedAfter(mics);
  const feed = (n, v) => nodes.at(-1).port.onmessage(frame(n, v));
  feed(700, 0.5); feed(700, 0.5); feed(700, 0.5); // captured while paused
  $('pause').click();
  feed(700, 0.25); feed(700, 0.25); feed(700, 0.25);

  await waitFor(() => audioChunks(socket).length >= 1, { what: 'chunk after resume' });
  assert.equal(audioChunks(socket).length, 1);
  assert.ok(audioChunks(socket)[0].every((x) => x === 8192), 'only post-resume samples were sent');
  assert.equal(socket.messages.filter((m) => m.realtimeInput?.audioStreamEnd).length, 1);
});

test('one button walks Connect → Connecting... → Disconnect → Connect', async () => {
  // Pins: the button's label, state, disabled and aria-busy follow the session
  // through idle, connecting, live and back to idle, and it is the only connect control.
  const release = holdTokenMint();
  $('connect').click();
  await waitFor(() => $('connect').textContent === 'Connecting...', { what: 'Connecting...' });
  assert.equal($('connect').disabled, true);
  assert.equal($('connect').getAttribute('aria-busy'), 'true');

  release();
  await waitFor(() => $('state').textContent === 'live', { what: 'state live' });
  assert.equal($('connect').textContent, 'Disconnect');
  assert.equal($('connect').dataset.state, 'live');
  assert.equal($('connect').disabled, false);
  assert.equal($('connect').getAttribute('aria-busy'), 'false');
  assert.equal($('disconnect'), null);
  const connectButtons = [...document.querySelectorAll('button')].filter((b) => /connect/i.test(b.textContent));
  assert.equal(connectButtons.length, 1);

  hangUp();
  assert.equal($('connect').textContent, 'Connect');
  assert.equal($('connect').dataset.state, 'idle');
});

test('clicks while connecting open no second connection', async () => {
  // Pins: however many times the button is clicked before or during connecting,
  // one attempt makes one token mint and one Gemini socket.
  const mintsBefore = mints();
  const socketsBefore = gemini.sessions.length;
  const release = holdTokenMint();
  $('connect').click();
  $('connect').click(); // lands in the audioCtx.resume() gap, while the state is still idle
  await waitFor(() => $('connect').textContent === 'Connecting...', { what: 'Connecting...' });
  $('connect').click();
  $('connect').click();

  release();
  await waitFor(() => $('state').textContent === 'live', { what: 'state live' });
  await new Promise((r) => setImmediate(r));
  assert.equal(mints() - mintsBefore, 1);
  assert.equal(gemini.sessions.length - socketsBefore, 1);
});

test('a failed connect returns the button to Connect and adds no divider', async () => {
  // Pins: connecting -> error leaves an enabled Connect button, reports the error,
  // adds no new-session marker, and does not wedge the next connect.
  const before = dividers().length;
  gemini.setConnectMode('reject');
  const release = holdTokenMint();
  $('connect').click();
  await waitFor(() => $('connect').textContent === 'Connecting...', { what: 'Connecting...' });
  release();

  await waitFor(() => $('state').textContent === 'error', { what: 'state error' });
  assert.equal($('connect').textContent, 'Connect');
  assert.equal($('connect').disabled, false);
  assert.equal($('connect').dataset.state, 'error');
  assert.ok(transcriptHas('Gemini closed the connection (1008: invalid token)'));
  assert.equal(dividers().length, before);

  gemini.setConnectMode('ok');
  await connectLive();
});

test('Gemini closing a live session returns the button to Connect', async () => {
  // Pins: a remote close with no resumption handle ends in an enabled Connect button.
  const { socket } = await connectLive();
  socket.close(1011, 'gone');
  await waitFor(() => $('state').textContent === 'error', { what: 'state error' });
  assert.equal($('connect').textContent, 'Connect');
  assert.equal($('connect').disabled, false);
  assert.ok(transcriptHas('Gemini closed the connection (1011: gone)'));
});

test('a resume keeps Disconnect and adds no divider', async () => {
  // Pins: only connecting -> live marks a new session; a resume is the same conversation.
  const { socket } = await connectLive();
  const count = dividers().length;
  await resume(socket);
  assert.equal($('connect').textContent, 'Disconnect');
  assert.equal(dividers().length, count);
});

test('a reconnect keeps earlier messages and adds exactly one divider after them', async () => {
  // Pins: the transcript is kept across Disconnect and Connect, and each new session adds one marker after it.
  const { socket } = await connectLive();
  socket.send({ serverContent: { outputTranscription: { text: 'first session reply' }, turnComplete: true } });
  await waitFor(() => transcriptHas('first session reply'), { what: 'reply in the transcript' });
  const n = dividers().length;

  hangUp();
  assert.equal(dividers().length, n);
  assert.ok(transcriptHas('first session reply'));

  await connectLive();
  assert.ok(transcriptHas('first session reply'));
  assert.equal(dividers().length, n + 1);
  const entry = [...$('transcript').querySelectorAll('.entry')].find((e) => e.textContent.includes('first session reply'));
  const divider = [...dividers()].at(-1);
  assert.ok(entry.compareDocumentPosition(divider) & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */);
  assert.match(divider.textContent, /^New session started · /);
});

test('a token request that never answers returns the button to Connect', async (t) => {
  // Pins: the page bounds its token request, so a stalled POST api/token ends the
  // attempt in `error` with an enabled Connect button instead of a stuck Connecting...
  // The page's timeout is shortened by wrapping AbortSignal.timeout.
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  t.after(() => { AbortSignal.timeout = realTimeout; });
  holdTokenMint();
  $('connect').click();
  await waitFor(() => $('connect').textContent === 'Connecting...', { what: 'Connecting...' });

  await waitFor(() => $('state').textContent === 'error', { what: 'state error' });
  assert.equal($('connect').textContent, 'Connect');
  assert.equal($('connect').disabled, false);
  assert.ok(transcriptHas('No response from the backend within'));
});
