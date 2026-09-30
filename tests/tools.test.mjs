// Pins: the four tools hit exactly the intended host calls, only ever touch
// conductor sessions (the worker guard), switch the active target only on a
// named send or create, and turn every failure into an {ok:false, code} result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, callTool, req, CONDUCTOR_A, CONDUCTOR_B, WORKER } from './helpers.mjs';

async function setup(t, { instances = [CONDUCTOR_A, CONDUCTOR_B, WORKER], events, active } = {}) {
  const host = await startFakeHost({ instances, events });
  const app = await startApp({ host });
  t.after(async () => { await app.stop(); await host.close(); });
  if (active) await app.deps.state.update({ activeTargetId: active, lastHandledTurnSeq: -1 });
  host.requests.length = 0;
  return { host, app };
}

const text = (t) => ({ kind: 'assistant_message', message: { content: [{ type: 'text', text: t }] } });
const toolOnly = { kind: 'assistant_message', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } };

test('list returns conductors only with one host call', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-b' });
  const r = await callTool(app, 'list_conductor_sessions');
  assert.deepEqual(host.requests.map((q) => `${q.method} ${q.url}`), ['GET /api/instances']);
  assert.deepEqual(r, {
    ok: true,
    sessions: [
      { sessionId: 'cond-a', title: 'Alpha plan', status: 'idle', lastResponseAt: 1, active: false },
      { sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…', status: 'turn', lastResponseAt: 2, active: true },
    ],
    activeTarget: { sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…' },
  });
  assert.equal(r.sessions[1].title.length, 60);
  const ui = await req(`${app.url}/api/conductors`);
  assert.deepEqual(ui.json, r, 'the target picker shares the tool implementation');
});

test('create ensures .conduct, spawns a conductor and makes it active', async (t) => {
  const { host, app } = await setup(t);
  const r = await callTool(app, 'create_conductor_session');
  assert.deepEqual(host.requests.map((q) => `${q.method} ${q.url}`), ['POST /api/projects/.conduct/ensure', 'POST /api/instances']);
  assert.deepEqual(host.requests[1].body, { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
  assert.equal(r.ok, true);
  assert.equal(r.activeTargetChanged, true);
  assert.deepEqual(r.activeTarget, { sessionId: 'new-conductor-1', title: 'Untitled conductor' });
  assert.equal(r.session.sessionId, 'new-conductor-1');
  assert.deepEqual(app.deps.state.get(), { activeTargetId: 'new-conductor-1', lastHandledTurnSeq: -1 });
});

test('send to the active target prompts over /ws without a target change', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  const r = await callTool(app, 'send_to_conductor', { text: 'run the tests' });
  assert.deepEqual(r, { ok: true, sessionId: 'cond-a', title: 'Alpha plan', delivered: true, note: 'The reply will be announced when the conductor finishes its turn.' });
  assert.equal(host.prompts.length, 1);
  assert.equal(host.prompts[0].id, 'cond-a');
  assert.equal(host.prompts[0].text, 'run the tests');
  assert.match(host.prompts[0].reqId, /^code-live-\d+$/);
});

test('send to a named session switches the active target and says so', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  const r = await callTool(app, 'send_to_conductor', { text: 'hi', session: 'cond-b' });
  assert.equal(r.activeTargetChanged, true);
  assert.deepEqual(r.activeTarget, { sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…' });
  assert.equal(app.deps.state.get().activeTargetId, 'cond-b');
  assert.equal(host.prompts[0].id, 'cond-b');
  // Titles resolve case-insensitively; naming the active one is no change.
  const again = await callTool(app, 'send_to_conductor', { text: 'x', session: 'alpha PLAN' });
  assert.equal(again.activeTargetChanged, true);
  const same = await callTool(app, 'send_to_conductor', { text: 'y', session: 'cond-a' });
  assert.equal(same.ok, true);
  assert.equal('activeTargetChanged' in same, false);
});

test('read returns the last N text messages and never changes the target', async (t) => {
  const { host, app } = await setup(t, {
    active: 'cond-a',
    events: { 'cond-b': [text('one'), toolOnly, text('two'), { kind: 'turn_end' }, text('three'), toolOnly] },
  });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-b', count: 2 });
  assert.deepEqual(r, { ok: true, sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…', messages: [{ text: 'two' }, { text: 'three' }] });
  assert.ok(host.requests.some((q) => q.url === '/api/instances/cond-b/events?limit=500'));
  assert.equal(app.deps.state.get().activeTargetId, 'cond-a');
  const one = await callTool(app, 'read_conductor_messages', { session: 'cond-b' });
  assert.deepEqual(one.messages, [{ text: 'three' }]);
});

test('worker sessions are refused everywhere', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  for (const [name, args] of [['send_to_conductor', { text: 'x', session: 'worker-1' }], ['read_conductor_messages', { session: 'worker-1' }]]) {
    const r = await callTool(app, name, args);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_A_CONDUCTOR');
  }
  assert.equal(host.prompts.length, 0, 'no prompt reaches a worker');
  assert.ok(!host.requests.some((q) => q.url.includes('worker-1')));
  const pick = await req(`${app.url}/api/target`, { method: 'PUT', body: { sessionId: 'worker-1' } });
  assert.equal(pick.status, 400);
  assert.equal(pick.json.code, 'NOT_A_CONDUCTOR');
  assert.equal(app.deps.state.get().activeTargetId, 'cond-a');
  // The worker shares a title with a conductor; titles match conductors only.
  const r = await callTool(app, 'send_to_conductor', { text: 'x', session: 'Alpha plan' });
  assert.equal(r.sessionId, 'cond-a');
});

test('session resolution errors', async (t) => {
  const dup = { ...CONDUCTOR_B, id: 'cond-c', title: 'Alpha plan' };
  const { app } = await setup(t, { instances: [CONDUCTOR_A, dup, WORKER] });
  assert.equal((await callTool(app, 'send_to_conductor', { text: 'x' })).code, 'NO_ACTIVE_TARGET');
  const unknown = await callTool(app, 'send_to_conductor', { text: 'x', session: 'nope' });
  assert.equal(unknown.code, 'UNKNOWN_SESSION');
  assert.match(unknown.message, /Alpha plan/);
  const amb = await callTool(app, 'read_conductor_messages', { session: 'alpha plan' });
  assert.equal(amb.code, 'AMBIGUOUS_SESSION');
  assert.match(amb.message, /cond-a/);
  assert.match(amb.message, /cond-c/);
  await app.deps.state.update({ activeTargetId: 'gone-id' });
  assert.equal((await callTool(app, 'read_conductor_messages')).code, 'SESSION_GONE');
  assert.equal(app.deps.state.get().activeTargetId, null, 'a vanished target is cleared');
});

test('argument validation and unknown tools', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  for (const [name, args] of [
    ['send_to_conductor', {}],
    ['send_to_conductor', { text: '   ' }],
    ['send_to_conductor', { text: 'x', session: 5 }],
    ['read_conductor_messages', { count: 0 }],
    ['read_conductor_messages', { count: 11 }],
    ['read_conductor_messages', { count: 1.5 }],
    ['list_conductor_sessions', [1]],
  ]) {
    assert.equal((await callTool(app, name, args)).code, 'INVALID_ARGS', `${name} ${JSON.stringify(args)}`);
  }
  assert.equal((await callTool(app, 'rm_rf', {})).code, 'UNKNOWN_TOOL');
  assert.equal((await callTool(app, 'toString', {})).code, 'UNKNOWN_TOOL');
  assert.equal(host.prompts.length, 0);
  const bad = await req(`${app.url}/api/tools/call`, { method: 'POST', body: { name: 3 } });
  assert.equal(bad.status, 400);
});

test('host ack failures surface as tool errors', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.setAckMode('refuse');
  const refused = await callTool(app, 'send_to_conductor', { text: 'x' });
  assert.equal(refused.code, 'HOST_REFUSED');
  assert.match(refused.message, /not running/);
  assert.equal(app.deps.state.get().activeTargetId, 'cond-a');
  const switched = await callTool(app, 'send_to_conductor', { text: 'x', session: 'cond-b' });
  assert.equal(switched.code, 'HOST_REFUSED');
  assert.ok(switched.message.endsWith('("Build the beta release pipeline and report back on everythi…" is now the active target.)'), switched.message);
  assert.equal(app.deps.state.get().activeTargetId, 'cond-b', 'the switch stands');
  host.setAckMode('silent');
  assert.equal((await callTool(app, 'send_to_conductor', { text: 'x' })).code, 'ACK_TIMEOUT');
});

test('an unreachable host is HOST_UNAVAILABLE', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  await host.close();
  assert.equal((await callTool(app, 'list_conductor_sessions')).code, 'HOST_UNAVAILABLE');
  assert.equal((await callTool(app, 'send_to_conductor', { text: 'x' })).code, 'HOST_UNAVAILABLE');
});
