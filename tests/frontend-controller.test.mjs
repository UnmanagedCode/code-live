// Pins the page controller against injected browser fakes: one click action
// connects from idle or error, disconnects from live or reconnecting, and does
// nothing while connecting; the AudioContext is created once, inside that
// action, and resumed on each connect; the store follows the session state, the
// pause and the host link; state details land in the transcript; a refused
// microphone permission sets micBlocked until a capture starts or the session is
// disconnected; failed loads are surfaced; one controller opens one EventSource.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppController } from '../frontend/src/lib/controller.js';
import { settingsLocked } from '../frontend/src/lib/controls.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}

const MODELS = [{ id: 'm1', label: 'One' }, { id: 'm2', label: 'Two', hint: 'slow' }];

function fakeEnv({ routes = {}, gum } = {}) {
  const calls = [];
  let tokenGate = null;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const base = {
    'GET api/models': () => json(200, { models: MODELS }),
    'GET api/settings': () => json(200, { apiKey: { set: true, tail: 'abcd' }, voice: null, customPrompt: '', customPromptMax: 100 }),
    'GET api/voices': () => json(200, { voices: [] }),
    'POST api/token': () => json(200, { token: 't', wsUrl: 'wss://gemini.test/live' }),
    ...routes,
  };
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    if (key === 'POST api/token' && tokenGate) await tokenGate;
    const route = base[key];
    if (!route) return json(404, { error: 'not found' });
    return route();
  };

  const sockets = [];
  class FakeSocket {
    readyState = 0;
    listeners = {};
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    emit(t, ev) { for (const fn of this.listeners[t] ?? []) fn(ev); }
    send(data) {
      const m = JSON.parse(data);
      this.sent.push(m);
      if (m.setup && !FakeSocket.rejectSetup) queueMicrotask(() => this.server({ setupComplete: {} }));
      if (m.setup && FakeSocket.rejectSetup) queueMicrotask(() => this.close(1008, 'invalid token'));
    }
    server(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
    close(code = 1005, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code, reason }); }
  }

  const eventSources = [];
  class FakeEventSource {
    listeners = {};
    constructor(url) { this.url = url; eventSources.push(this); }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    emit(t, data) { for (const fn of this.listeners[t] ?? []) fn({ data: JSON.stringify(data), lastEventId: '' }); }
    close() {}
  }

  const contexts = [];
  class FakeAudioContext {
    sampleRate = 16000;
    currentTime = 0;
    resumes = 0;
    audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    async resume() { this.resumes++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  const nodes = [];
  class FakeNode { port = {}; constructor() { nodes.push(this); } connect() {} disconnect() {} }
  const tracks = [];
  const mediaDevices = {
    getUserMedia: (c) => (gum ? gum(c) : Promise.resolve(stream())),
  };
  function stream() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  }

  const env = { fetchImpl, WebSocketImpl: FakeSocket, EventSourceImpl: FakeEventSource, AudioContextImpl: FakeAudioContext, AudioWorkletNodeImpl: FakeNode, mediaDevices, now: () => new Date(2026, 0, 1) };
  const holdToken = () => { let release; tokenGate = new Promise((r) => { release = r; }); return () => { tokenGate = null; release(); }; };
  return { env, calls, sockets, eventSources, contexts, nodes, tracks, holdToken, FakeSocket };
}

async function build(opts) {
  const f = fakeEnv(opts);
  const c = createAppController(f.env);
  await until(() => c.store.get().models.length > 0 || c.store.get().modelsError, 'models');
  await until(() => c.settings.store.get().settled, 'settings');
  return { c, ...f, state: () => c.store.get().state, mints: () => f.calls.filter((x) => x.key === 'POST api/token') };
}

async function goLive(t) {
  await t.c.toggleConnect();
  await until(() => t.state() === 'live', 'live');
  await until(() => t.nodes.length > 0 && t.nodes.at(-1).port.onmessage, 'mic started');
}

test('one click action: connect from idle, nothing while connecting, disconnect from live', async () => {
  const t = await build();
  const release = t.holdToken();
  const first = t.c.toggleConnect();
  await until(() => t.state() === 'connecting', 'connecting');
  await t.c.toggleConnect();
  await t.c.toggleConnect();
  release();
  await first;
  await until(() => t.state() === 'live', 'live');
  assert.equal(t.mints().length, 1, 'clicks while connecting mint nothing');
  assert.equal(t.sockets.length, 1);
  await t.c.toggleConnect();
  assert.equal(t.state(), 'idle');
  assert.equal(t.sockets[0].readyState, 3);
});

test('two clicks before the state leaves idle still make one connection', async () => {
  const t = await build();
  const a = t.c.toggleConnect();
  const b = t.c.toggleConnect(); // lands while the AudioContext resumes
  await Promise.all([a, b]);
  await until(() => t.state() === 'live', 'live');
  await tick();
  assert.equal(t.mints().length, 1);
});

test('connects again from error, and the error detail lands in the transcript as an error', async () => {
  const t = await build();
  t.FakeSocket.rejectSetup = true;
  try {
    await t.c.toggleConnect();
    await until(() => t.state() === 'error', 'error');
  } finally { t.FakeSocket.rejectSetup = false; }
  const last = t.c.transcript.getSnapshot().at(-1);
  assert.deepEqual([last.kind, last.body], ['error', 'Gemini closed the connection (1008: invalid token)']);
  await goLive(t);
  assert.equal(t.mints().length, 2);
});

test('the AudioContext is created once, inside the click action, and resumed on every connect', async () => {
  const t = await build();
  assert.equal(t.contexts.length, 0, 'nothing audio before the first click');
  await goLive(t);
  await t.c.toggleConnect();
  await goLive(t);
  assert.equal(t.contexts.length, 1);
  assert.equal(t.contexts[0].resumes, 2);
});

test('the first model is selected once loaded; setModel picks the model the next connect mints', async () => {
  const t = await build();
  assert.equal(t.c.store.get().modelId, 'm1');
  t.c.setModel('m2');
  await goLive(t);
  assert.equal(t.mints()[0].body.model, 'm2');
});

test('the store follows the session: state, pause, and the settings lock while connecting, live and reconnecting', async () => {
  const t = await build();
  const seen = [];
  t.c.store.subscribe(() => { const s = t.c.store.get().state; if (seen.at(-1) !== s) seen.push(s); });
  await goLive(t);
  t.c.toggleMic();
  assert.equal(t.c.store.get().micPaused, true);
  t.c.toggleMic();
  assert.equal(t.c.store.get().micPaused, false);
  const release = t.holdToken();
  t.sockets[0].server({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  t.sockets[0].server({ goAway: { timeLeft: '5s' } });
  await until(() => t.state() === 'reconnecting', 'reconnecting');
  t.c.toggleMic();
  assert.equal(t.c.store.get().micPaused, true, 'a pause is possible while reconnecting');
  release();
  await until(() => t.state() === 'live', 'live again');
  assert.equal(t.c.store.get().micPaused, true, 'the pause survives the resume');
  await t.c.toggleConnect();
  assert.equal(t.c.store.get().micPaused, false, 'Disconnect clears the pause');
  assert.deepEqual(seen, ['connecting', 'live', 'reconnecting', 'live', 'idle']);
  assert.deepEqual(seen.map(settingsLocked), [true, true, true, true, false]);
});

test('a resume starts no second capture; Disconnect stops the track', async () => {
  const t = await build();
  await goLive(t);
  t.sockets[0].server({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  t.sockets[0].server({ goAway: { timeLeft: '5s' } });
  await until(() => t.sockets.length === 2 && t.state() === 'live', 'resumed');
  await tick();
  assert.equal(t.nodes.length, 1);
  await t.c.toggleConnect();
  assert.equal(t.tracks[0].stopped, true);
});

for (const name of ['NotAllowedError', 'SecurityError']) {
  test(`a ${name} from getUserMedia sets micBlocked; a capture that starts clears it`, async () => {
    let refuse = true;
    const t = await build({ gum: () => (refuse ? Promise.reject(Object.assign(new Error('Permission denied'), { name })) : Promise.resolve({ getTracks: () => [] })) });
    await t.c.toggleConnect();
    await until(() => t.c.store.get().micBlocked, 'micBlocked');
    assert.equal(t.c.transcript.getSnapshot().at(-1).body, 'Microphone: Permission denied');
    refuse = false;
    t.sockets[0].server({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
    t.sockets[0].server({ goAway: { timeLeft: '5s' } });
    await until(() => t.nodes.length === 1, 'capture after resume');
    await tick();
    assert.equal(t.c.store.get().micBlocked, false);
  });
}

test('Disconnect clears micBlocked; another microphone failure does not set it', async () => {
  let err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const t = await build({ gum: () => Promise.reject(err) });
  await t.c.toggleConnect();
  await until(() => t.c.store.get().micBlocked, 'micBlocked');
  await t.c.toggleConnect();
  assert.equal(t.state(), 'idle');
  assert.equal(t.c.store.get().micBlocked, false);
  err = Object.assign(new Error('no device'), { name: 'NotFoundError' });
  await t.c.toggleConnect();
  await until(() => t.c.transcript.getSnapshot().some((e) => e.body === 'Microphone: no device'), 'error line');
  assert.equal(t.c.store.get().micBlocked, false);
});

test('a failed models load sets modelsError and adds the transcript line; a failed settings load sets loadError', async () => {
  const fail = () => ({ ok: false, status: 503, json: async () => ({ error: 'backend restarting' }) });
  const t = await build({ routes: { 'GET api/models': fail, 'GET api/settings': fail } });
  assert.equal(t.c.store.get().modelsError, 'backend restarting');
  assert.deepEqual(t.c.store.get().models, []);
  assert.ok(t.c.transcript.getSnapshot().some((e) => e.kind === 'error' && e.body === 'Loading models failed: backend restarting'));
  assert.equal(t.c.settings.store.get().loadError, 'backend restarting');
});

test('one controller opens one EventSource on api/events; host events set hostConnected', async () => {
  const t = await build();
  assert.equal(t.eventSources.length, 1);
  assert.equal(t.eventSources[0].url, 'api/events');
  assert.equal(t.c.store.get().hostConnected, false);
  t.eventSources[0].emit('host', { connected: true });
  assert.equal(t.c.store.get().hostConnected, true);
  t.eventSources[0].emit('host', { connected: false });
  assert.equal(t.c.store.get().hostConnected, false);
  await goLive(t);
  await t.c.toggleConnect();
  assert.equal(t.eventSources.length, 1, 'connecting opens no other stream');
});

test('a conductor announce while live is injected into the session and added to the transcript', async () => {
  const t = await build();
  await goLive(t);
  t.eventSources[0].emit('announce', { sessionId: 'c', title: 'Alpha', text: 'done' });
  assert.equal(t.c.transcript.getSnapshot().at(-1).label, 'Conductor · Alpha');
  assert.ok(t.sockets[0].sent.some((m) => m.realtimeInput?.text === 'CONDUCTOR UPDATE from "Alpha" (session c):\ndone'));
});
