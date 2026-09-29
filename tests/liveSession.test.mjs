// Pins: the browser Live client connects with a backend-minted token, decodes
// binary frames into events, round-trips tool calls through the backend
// (skipping cancelled ones), injects text as realtimeInput, and resumes with
// the latest handle on goAway or a drop until it gives up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession } from '../public/liveSession.js';
import { createApi } from '../public/api.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, waitFor, SENTINEL_KEY, CONDUCTOR_A, WORKER } from './helpers.mjs';

async function setup(t, apiOverrides = {}) {
  const gemini = await startFakeGemini();
  const host = await startFakeHost({ instances: [CONDUCTOR_A, WORKER] });
  const app = await startApp({ gemini, host });
  await app.deps.keyStore.set(SENTINEL_KEY);
  const api = { ...createApi((u, o) => fetch(new URL(u, app.url + '/'), o)), ...apiOverrides };
  const events = [];
  const session = createLiveSession({ api, onEvent: (e) => events.push(e) });
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
  session.endAudio();
  assert.deepEqual(await s.next((m) => m.realtimeInput?.text), { realtimeInput: { text: 'CONDUCTOR UPDATE from "x":\nhi' } });
  assert.deepEqual(await s.next((m) => m.realtimeInput?.audio), { realtimeInput: { audio: { data: 'AQID', mimeType: 'audio/pcm;rate=16000' } } });
  assert.deepEqual(await s.next((m) => m.realtimeInput?.audioStreamEnd), { realtimeInput: { audioStreamEnd: true } });
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
  assert.equal(mints(gemini).length, 4, 'one connect + three resume attempts');
  assert.match(events.at(-1).detail, /resume/);
});

test('disconnect goes idle and closes the socket', async (t) => {
  const { gemini, session } = await setup(t);
  await session.connect('gemini-3.8-live');
  const s0 = await gemini.session(0);
  session.disconnect();
  assert.equal(session.state, 'idle');
  assert.equal(await s0.closed, 1000);
});
