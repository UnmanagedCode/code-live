// Pins: the browser Live client connects with a backend-minted token, decodes
// binary frames into events, round-trips tool calls through the backend
// (skipping cancelled ones), injects text as realtimeInput, and resumes with
// the latest handle on goAway or a drop until it gives up. The mic pause gates
// audio only (one audioStreamEnd, text still flows), survives reconnects on the
// same handle, and is cleared by every state other than live/reconnecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession } from '../public/liveSession.js';
import { createApi } from '../public/api.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, waitFor, SENTINEL_KEY, CONDUCTOR_A, WORKER } from './helpers.mjs';

async function setup(t, apiOverrides = {}, sessionOpts = {}) {
  const gemini = await startFakeGemini();
  const host = await startFakeHost({ instances: [CONDUCTOR_A, WORKER] });
  const app = await startApp({ gemini, host });
  await app.deps.keyStore.set(SENTINEL_KEY);
  const api = { ...createApi((u, o) => fetch(new URL(u, app.url + '/'), o)), ...apiOverrides };
  const events = [];
  const session = createLiveSession({ api, onEvent: (e) => events.push(e), resumeDelayMs: 0, ...sessionOpts });
  t.after(async () => { session.disconnect(); await app.stop(); await host.close(); await gemini.close(); });
  return { gemini, host, app, api, events, session };
}

const states = (events) => events.filter((e) => e.type === 'state').map((e) => e.state);
const mints = (gemini) => gemini.requests.filter((r) => r.url === '/v1beta/auth_tokens');

test('connect mints a token, sends an empty setup and goes live', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.1-flash-live-preview');
  assert.equal(session.state, 'live');
  assert.deepEqual(states(events), ['connecting', 'live']);
  const s = await gemini.session(0);
  assert.deepEqual(s.messages[0], { setup: {} });
  assert.equal(mints(gemini)[0].body.bidiGenerateContentSetup.model, 'models/gemini-3.1-flash-live-preview');
});

test('a token request that never answers ends the attempt in error', async (t) => {
  // Pins: the browser's token request is time-bounded, so a connect that is stuck on
  // an unanswered POST api/token ends in `error` instead of staying `connecting`.
  const hang = (u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)));
  const { events, session } = await setup(t, { mintToken: createApi(hang, { tokenTimeoutMs: 20 }).mintToken });
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'error');
  assert.deepEqual(states(events), ['connecting', 'error']);
  assert.match(events.at(-1).detail, /^No response from the backend within /);
});

test('binary server frames become events; empty messages are ignored', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s = await gemini.session(0);
  s.send({});
  s.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] } } });
  s.send({ serverContent: { inputTranscription: { text: 'hello' } } });
  s.send({ serverContent: { outputTranscription: { text: 'hi there' } } });
  s.send({ serverContent: { interrupted: true } });
  s.send({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' } });
  await waitFor(() => events.some((e) => e.type === 'turn_complete'));
  assert.deepEqual(events.filter((e) => e.type !== 'state'), [
    { type: 'audio', data: 'AAA=', mimeType: 'audio/pcm;rate=24000' },
    { type: 'input_transcript', text: 'hello' },
    { type: 'output_transcript', text: 'hi there' },
    { type: 'interrupted' },
    { type: 'turn_complete', interactionStatus: 'IDLE' },
  ]);
});

test('a tool call runs through the backend and returns a toolResponse', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s = await gemini.session(0);
  s.send({ toolCall: { functionCalls: [{ id: 'call-1', name: 'list_conductor_sessions', args: {} }] } });
  const msg = await s.next((m) => m.toolResponse);
  const [resp] = msg.toolResponse.functionResponses;
  assert.equal(resp.id, 'call-1');
  assert.equal(resp.name, 'list_conductor_sessions');
  assert.equal(resp.response.ok, true);
  assert.deepEqual(resp.response.sessions.map((x) => x.sessionId), ['cond-a']);
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), { type: 'tool_call', id: 'call-1', name: 'list_conductor_sessions', args: {} });
  assert.equal(events.find((e) => e.type === 'tool_result').result.ok, true);
});

test('a cancelled tool call sends no toolResponse; a failing one reports CLIENT_ERROR', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { gemini, events, session } = await setup(t, {
    callTool: async (name) => {
      if (name === 'slow') { await gate; return { ok: true }; }
      throw new Error('network down');
    },
  });
  await session.connect('gemini-3.8-live-extended-thinking');
  const s = await gemini.session(0);
  s.send({ toolCall: { functionCalls: [{ id: 'c-slow', name: 'slow', args: {} }] } });
  await waitFor(() => events.some((e) => e.type === 'tool_call'));
  s.send({ toolCallCancellation: { ids: ['c-slow'] } });
  await waitFor(() => events.some((e) => e.type === 'tool_cancelled'));
  release();
  await waitFor(() => events.some((e) => e.type === 'tool_result' && e.id === 'c-slow'));
  s.send({ toolCall: { functionCalls: [{ id: 'c-bad', name: 'broken', args: {} }] } });
  const msg = await s.next((m) => m.toolResponse);
  assert.deepEqual(msg.toolResponse.functionResponses, [{ id: 'c-bad', name: 'broken', response: { ok: false, code: 'CLIENT_ERROR', message: 'network down' } }]);
  assert.equal(s.messages.filter((m) => m.toolResponse).length, 1, 'the cancelled call got no response');
});

test('sendText and sendAudio frame realtimeInput; nothing is sent unless live', async (t) => {
  const { gemini, session } = await setup(t);
  session.sendText('too early');
  session.sendAudio('AAAA');
  await session.connect('gemini-3.8-live');
  const s = await gemini.session(0);
  session.sendText('CONDUCTOR UPDATE from "x":\nhi');
  session.sendAudio('AQID');
  assert.deepEqual(await s.next((m) => m.realtimeInput?.text), { realtimeInput: { text: 'CONDUCTOR UPDATE from "x":\nhi' } });
  assert.deepEqual(await s.next((m) => m.realtimeInput?.audio), { realtimeInput: { audio: { data: 'AQID', mimeType: 'audio/pcm;rate=16000' } } });
  assert.equal(s.messages.some((m) => JSON.stringify(m).includes('too early') || JSON.stringify(m).includes('AAAA')), false);
});

test('goAway resumes on a new socket with the latest handle', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s0.send({ sessionResumptionUpdate: { newHandle: '', resumable: false } });
  s0.send({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  s0.send({ goAway: { timeLeft: '5s' } });
  const s1 = await gemini.session(1);
  assert.equal(await s0.closed, 1000, 'the old socket is closed normally');
  await waitFor(() => session.state === 'live' && states(events).includes('reconnecting'));
  assert.deepEqual(mints(gemini)[1].body.bidiGenerateContentSetup.sessionResumption, { handle: 'h2' });
  assert.deepEqual(s1.messages[0], { setup: {} });
  assert.deepEqual(states(events), ['connecting', 'live', 'reconnecting', 'live']);
  session.sendText('after resume');
  assert.ok(await s1.next((m) => m.realtimeInput?.text === 'after resume'));
});

test('an unexpected close resumes when a handle exists, else errors', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  // Frames on one socket arrive in order: once this event is seen, so is the handle.
  s0.send({ serverContent: { turnComplete: true } });
  await waitFor(() => events.some((e) => e.type === 'turn_complete'));
  s0.close(1011, 'server restart');
  await gemini.session(1);
  await waitFor(() => session.state === 'live' && states(events).includes('reconnecting'));

  session.disconnect();
  events.length = 0;
  await session.connect('gemini-3.8-live');
  (await gemini.session(2)).close(1011, 'boom');
  await waitFor(() => session.state === 'error');
  assert.match(events.at(-1).detail, /1011/);
});

test('repeated resume failures end in error', async (t) => {
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  gemini.setConnectMode('reject');
  s0.send({ goAway: { timeLeft: '1s' } });
  await waitFor(() => session.state === 'error');
  assert.equal(mints(gemini).length, 6, 'one connect + five resume attempts');
  assert.match(events.at(-1).detail, /resume/);
});

// Records every timer delay; resume waits fire at once, the setup timeout never does.
function recordingTimers(setupTimeoutMs) {
  const delays = [];
  return {
    delays,
    timers: {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        if (ms === setupTimeoutMs) { const h = setTimeout(fn, ms); h.unref(); return h; }
        return setTimeout(fn, 1);
      },
      clearTimeout: (h) => clearTimeout(h),
    },
  };
}

test('resume attempts are spaced out and survive a backend outage of a few seconds', async (t) => {
  // Pins: a resume that meets a 503 from the backend (its restart backoff)
  // waits resumeDelayMs * 2^(n-1) before the next attempt, and the call is
  // live again on the original handle once the backend answers.
  const { delays, timers } = recordingTimers(60000);
  let real;
  let resumeCalls = 0;
  const { gemini, app, events, session } = await setup(t, {
    mintToken: (model, h) => {
      if (h && ++resumeCalls <= 2) return Promise.reject(new Error('HTTP 503'));
      return real.mintToken(model, h);
    },
  }, { resumeDelayMs: 1000, setupTimeoutMs: 60000, timers });
  real = createApi((u, o) => fetch(new URL(u, app.url + '/'), o));
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s0.send({ goAway: { timeLeft: '1s' } });
  await gemini.session(1);
  await waitFor(() => session.state === 'live' && states(events).includes('reconnecting'));
  assert.equal(resumeCalls, 3, 'two rejected attempts, then one that went through');
  assert.deepEqual(delays.filter((ms) => ms !== 60000), [1000, 2000]);
  assert.deepEqual(mints(gemini)[1].body.bidiGenerateContentSetup.sessionResumption, { handle: 'h1' });
  assert.deepEqual(states(events), ['connecting', 'live', 'reconnecting', 'live']);
});

test('disconnect during the wait between resume attempts stops the loop', async (t) => {
  // Pins: a Disconnect while the resume loop waits ends in idle and the
  // pending wait mints nothing when it fires.
  // Resume waits are held until the test fires them; the setup timeout never fires.
  const waits = [];
  const timers = { setTimeout: (fn, ms) => { if (ms !== 15000) waits.push(fn); return 0; }, clearTimeout: () => {} };
  let mintCalls = 0;
  let real;
  const { gemini, app, events, session } = await setup(t, {
    mintToken: (model, h) => {
      if (!h) return real.mintToken(model, h);
      mintCalls++;
      return Promise.reject(new Error('HTTP 503'));
    },
  }, { resumeDelayMs: 1000, timers });
  real = createApi((u, o) => fetch(new URL(u, app.url + '/'), o));
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s0.send({ goAway: { timeLeft: '1s' } });
  await waitFor(() => waits.length === 1);
  assert.equal(mintCalls, 1, 'the first resume attempt ran, the second is waiting');
  session.disconnect();
  assert.equal(session.state, 'idle');
  waits[0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mintCalls, 1, 'the abandoned wait mints nothing');
  assert.equal(session.state, 'idle');
  assert.equal(states(events).at(-1), 'idle');
});

test('disconnect goes idle and closes the socket', async (t) => {
  const { gemini, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  session.disconnect();
  assert.equal(session.state, 'idle');
  assert.equal(await s0.closed, 1000);
});

test('a handshake with no setupComplete times out: connect ends in error', async (t) => {
  const { gemini, events, session } = await setup(t, {}, { setupTimeoutMs: 30 });
  gemini.setConnectMode('silent');
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'error');
  assert.match(events.at(-1).detail, /did not complete setup/);
  assert.ok(await (await gemini.session(0)).closed, 'the stalled socket is closed');
  // A new Connect works once the server answers again.
  gemini.setConnectMode('ok');
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'live');
});

test('a stalled resume counts as a failed attempt', async (t) => {
  const { gemini, events, session } = await setup(t, {}, { setupTimeoutMs: 30 });
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  gemini.setConnectMode('silent');
  s0.send({ goAway: { timeLeft: '1s' } });
  await waitFor(() => session.state === 'error');
  assert.equal(mints(gemini).length, 6, 'one connect + five timed-out resume attempts');
  assert.equal(gemini.sessions.length, 6);
  assert.match(events.at(-1).detail, /did not complete setup/);
});

test('disconnect works while connecting and while reconnecting', async (t) => {
  const { gemini, events, session } = await setup(t, {}, { setupTimeoutMs: 60000 });
  gemini.setConnectMode('silent');
  const connecting = session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  assert.equal(session.state, 'connecting');
  session.disconnect();
  assert.equal(session.state, 'idle');
  // Closed from the client side (1000, or 1006 if still CONNECTING there).
  assert.ok([1000, 1006].includes(await s0.closed));
  await connecting;
  assert.equal(session.state, 'idle', 'the abandoned attempt does not report an error');

  gemini.setConnectMode('ok');
  await session.connect('gemini-3.8-live');
  const s1 = await gemini.session(1);
  s1.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  gemini.setConnectMode('silent');
  s1.send({ goAway: { timeLeft: '1s' } });
  const s2 = await gemini.session(2);
  assert.equal(session.state, 'reconnecting');
  session.disconnect();
  assert.equal(session.state, 'idle');
  assert.ok([1000, 1006].includes(await s2.closed));
  assert.equal(states(events).at(-1), 'idle');
  // A fresh connect is the only new mint: the abandoned resume loop stopped.
  gemini.setConnectMode('ok');
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'live');
  assert.equal(mints(gemini).length, 4, 'connect, connect, one resume attempt, connect');
  assert.equal(gemini.sessions.length, 4);
});

test('a setup timer that fires synchronously still fails and closes the socket', async (t) => {
  const sockets = [];
  class Recording extends WebSocket {
    constructor(...a) { super(...a); sockets.push(this); }
  }
  const { events, session } = await setup(t, {}, {
    WebSocketImpl: Recording,
    setupTimeoutMs: 15000,
    timers: { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} },
  });
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'error');
  assert.equal(events.at(-1).detail, 'Gemini did not complete setup within 15 s');
  assert.equal(sockets.length, 1);
  assert.ok(sockets[0].readyState >= 2, 'the socket is closing or closed');
});

const micEvents = (events) => events.filter((e) => e.type === 'mic').map((e) => e.paused);

// Frames on one socket arrive in order: once the marker text is received, every
// earlier frame is already in s.messages, so absence can be asserted.
async function flushed(session, s, marker) {
  session.sendText(marker);
  await s.next((m) => m.realtimeInput?.text === marker);
}
const audioFrames = (s) => s.messages.filter((m) => m.realtimeInput?.audio).map((m) => m.realtimeInput.audio.data);
const streamEnds = (s) => s.messages.filter((m) => m.realtimeInput?.audioStreamEnd).length;

test('pauseMic sends one audioStreamEnd and drops audio until resumeMic; text still goes through', async (t) => {
  // Pins: a pause gates the mic only (announcements are still spoken), sends
  // audioStreamEnd exactly once, and leaves the socket, state and token alone.
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s = await gemini.session(0);
  session.sendAudio('AQID');
  await s.next((m) => m.realtimeInput?.audio);
  session.pauseMic();
  session.pauseMic();
  assert.equal(session.micPaused, true);
  await s.next((m) => m.realtimeInput?.audioStreamEnd);
  session.sendAudio('PAUSED');
  session.sendText('CONDUCTOR UPDATE from "x":\nhi');
  await s.next((m) => m.realtimeInput?.text);
  session.resumeMic();
  assert.equal(session.micPaused, false);
  session.sendAudio('BACK');
  await s.next((m) => m.realtimeInput?.audio?.data === 'BACK');
  assert.equal(s.messages.some((m) => JSON.stringify(m).includes('PAUSED')), false);
  assert.equal(streamEnds(s), 1);
  assert.deepEqual(states(events), ['connecting', 'live']);
  assert.deepEqual(micEvents(events), [true, false]);
  assert.equal(mints(gemini).length, 1);
  assert.equal(gemini.sessions.length, 1);
});

test('a pause survives goAway: the resumed socket stays gated until resumeMic', async (t) => {
  // Pins: the pause intent outlives reconnect() and never goes through
  // disconnect(), so the resumption handle is still used.
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s0.send({ serverContent: { turnComplete: true } });
  await waitFor(() => events.some((e) => e.type === 'turn_complete'));
  session.pauseMic();
  s0.send({ goAway: { timeLeft: '5s' } });
  const s1 = await gemini.session(1);
  await waitFor(() => session.state === 'live' && states(events).includes('reconnecting'));
  assert.equal(session.micPaused, true);
  assert.deepEqual(mints(gemini)[1].body.bidiGenerateContentSetup.sessionResumption, { handle: 'h1' });
  session.sendAudio('X');
  await flushed(session, s1, 'marker');
  assert.deepEqual(audioFrames(s1), []);
  assert.equal(streamEnds(s1), 0);
  session.resumeMic();
  session.sendAudio('Y');
  await s1.next((m) => m.realtimeInput?.audio?.data === 'Y');
  assert.deepEqual(micEvents(events), [true, false]);
});

test('a pause survives an unexpected close with a handle', async (t) => {
  // Pins: the close-handler reconnect path keeps the pause, like goAway.
  const { gemini, events, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s0.send({ serverContent: { turnComplete: true } });
  await waitFor(() => events.some((e) => e.type === 'turn_complete'));
  session.pauseMic();
  s0.close(1011, 'server restart');
  const s1 = await gemini.session(1);
  await waitFor(() => session.state === 'live' && states(events).includes('reconnecting'));
  assert.equal(session.micPaused, true);
  session.sendAudio('X');
  await flushed(session, s1, 'marker');
  assert.deepEqual(audioFrames(s1), []);
  assert.equal(streamEnds(s1), 0);
});

test('pausing while reconnecting is kept when the resume lands', async (t) => {
  // Pins: a pause set with no socket sends nothing and is kept once the resume completes.
  const { gemini, events, session } = await setup(t, {}, { setupTimeoutMs: 30 });
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  s0.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  gemini.setConnectMode('silent');
  s0.send({ goAway: { timeLeft: '1s' } });
  await waitFor(() => session.state === 'reconnecting');
  session.pauseMic();
  gemini.setConnectMode('ok');
  await waitFor(() => session.state === 'live');
  assert.equal(session.micPaused, true);
  assert.deepEqual(micEvents(events), [true]);
  session.sendAudio('X');
  const last = await gemini.session(gemini.sessions.length - 1);
  await flushed(session, last, 'marker');
  for (const sock of gemini.sessions) {
    assert.deepEqual(audioFrames(sock), []);
    assert.equal(streamEnds(sock), 0);
  }
});

test('pauseMic and resumeMic are no-ops in idle, connecting and error', async (t) => {
  // Pins: a pause needs a live or reconnecting session. Pausing anywhere else
  // sets no flag (a stale one would survive into the next live state) and emits no event.
  const { gemini, events, session } = await setup(t, {}, { setupTimeoutMs: 60000 });
  const inert = (where) => {
    session.pauseMic();
    session.resumeMic();
    assert.equal(session.micPaused, false, where);
    assert.deepEqual(micEvents(events), [], where);
  };
  inert('idle');

  gemini.setConnectMode('silent');
  const connecting = session.connect('gemini-3.8-live');
  await gemini.session(0);
  assert.equal(session.state, 'connecting');
  inert('connecting');
  session.disconnect();
  await connecting;

  gemini.setConnectMode('reject');
  await session.connect('gemini-3.8-live');
  assert.equal(session.state, 'error');
  inert('error');
});

test('disconnect, a failed resume and a no-handle close all clear the pause', async (t) => {
  // Pins: a pause lasts only through live/reconnecting; any other state ends it.
  const { gemini, events, session } = await setup(t);
  // A: disconnect
  await session.connect('gemini-3.8-live');
  session.pauseMic();
  session.disconnect();
  assert.equal(session.micPaused, false);
  assert.deepEqual(micEvents(events), [true, false]);
  await session.connect('gemini-3.8-live');
  const s1 = await gemini.session(1);
  session.sendAudio('A');
  await s1.next((m) => m.realtimeInput?.audio?.data === 'A');
  // B: resume fails
  s1.send({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  s1.send({ serverContent: { turnComplete: true } });
  await waitFor(() => events.some((e) => e.type === 'turn_complete'));
  session.pauseMic();
  gemini.setConnectMode('reject');
  s1.send({ goAway: { timeLeft: '1s' } });
  await waitFor(() => session.state === 'error');
  assert.equal(session.micPaused, false);
  // C: close without a handle
  gemini.setConnectMode('ok');
  await session.connect('gemini-3.8-live');
  const s = await gemini.session(gemini.sessions.length - 1);
  session.pauseMic();
  assert.equal(session.micPaused, true);
  s.close(1011, 'boom');
  await waitFor(() => session.state === 'error');
  assert.equal(session.micPaused, false);
  assert.deepEqual(micEvents(events), [true, false, true, false, true, false]);
});
