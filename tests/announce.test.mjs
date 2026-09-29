// Pins: every finished turn of the active conductor is announced over SSE
// exactly once, including turns whose notification was missed (host /ws down,
// backend restarted, or a fast turn right after a target switch), while old
// turns, other sessions and duplicate notifications stay silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, sseClient, callTool, req, waitFor, CONDUCTOR_A, CONDUCTOR_B, WORKER } from './helpers.mjs';

const reply = (text) => ({ kind: 'assistant_message', message: { content: [{ type: 'text', text }] } });

async function setup(t, { events = {}, active = 'cond-a', baseline = true } = {}) {
  const host = await startFakeHost({ instances: [CONDUCTOR_A, CONDUCTOR_B, WORKER], events });
  const app = await startApp({ host });
  if (active) {
    if (baseline) await app.deps.service.setTarget(active);
    else await app.deps.state.update({ activeTargetId: active, lastHandledTurnSeq: -1 });
  }
  const sse = sseClient(`${app.url}/api/events`);
  await sse.ready;
  await sse.next('target');
  t.after(async () => { sse.close(); await app.stop(); await host.close(); });
  return { host, app, sse };
}

// Publishes a marker and waits for it: every SSE event published before it
// has then been received.
async function drain(app, sse) {
  await app.deps.announcer.reconcile();
  app.deps.sse.publish('marker', {});
  await sse.next('marker');
  return sse.events.filter((e) => e.event === 'announce').map((e) => e.data);
}

test('a turn_notification for the active target announces its last text reply', async (t) => {
  const { host, app, sse } = await setup(t);
  host.addEvent('cond-a', reply('thinking out loud'));
  host.addEvent('cond-a', { kind: 'assistant_message', message: { content: [{ type: 'text', text: 'Done: ' }, { type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: 'all green' }] } });
  host.addEvent('cond-a', { kind: 'assistant_message', message: { content: [{ type: 'tool_use', id: 'u', name: 'y', input: {} }] } });
  const end = host.addEvent('cond-a', { kind: 'turn_end', isError: false });
  host.broadcast({ t: 'turn_notification', id: 'cond-a', project: '.conduct', isError: false });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data, { sessionId: 'cond-a', title: 'Alpha plan', text: 'Done: \nall green', turnSeq: end._seq, isError: false });
  assert.match(ev.id, /^[0-9a-f]+-\d+$/);
  assert.equal(app.deps.state.get().lastHandledTurnSeq, end._seq);
});

test('other sessions and duplicate notifications are not announced', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-b', 'not the target');
  host.finishTurn('cond-a', 'the target');
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  await waitFor(() => host.requests.filter((q) => q.url.startsWith('/api/instances/cond-a/events')).length >= 3);
  const announced = await drain(app, sse);
  assert.deepEqual(announced.map((a) => a.text), ['the target']);
});

test('switching target baselines: its earlier turns stay silent', async (t) => {
  const { host, app, sse } = await setup(t, { events: { 'cond-b': [reply('old news'), { kind: 'turn_end' }] } });
  const r = await req(`${app.url}/api/target`, { method: 'PUT', body: { sessionId: 'cond-b' } });
  assert.deepEqual(r.json.activeTarget, { sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…' });
  const target = await sse.next('target', (d) => d?.sessionId === 'cond-b');
  assert.equal(target.data.sessionId, 'cond-b');
  host.broadcast({ t: 'turn_notification', id: 'cond-b' });
  assert.deepEqual(await drain(app, sse), []);
  host.finishTurn('cond-b', 'fresh news');
  assert.equal((await sse.next('announce')).data.text, 'fresh news');
});

test('a turn that ends right after a switching send is still announced', async (t) => {
  const { host, app, sse } = await setup(t, { events: { 'cond-b': [reply('old news'), { kind: 'turn_end' }] } });
  // The host finishes the turn (and notifies) before it even acks the prompt.
  host.onPrompt((msg) => host.finishTurn(msg.id, `reply to ${msg.text}`));
  const r = await callTool(app, 'send_to_conductor', { text: 'go', session: 'cond-b' });
  assert.equal(r.activeTargetChanged, true);
  const ev = await sse.next('announce');
  assert.equal(ev.data.sessionId, 'cond-b');
  assert.equal(ev.data.text, 'reply to go');
  assert.deepEqual((await drain(app, sse)).map((a) => a.text), ['reply to go']);
});

test('a create followed by a fast first turn is announced', async (t) => {
  const { host, app, sse } = await setup(t, { active: null });
  host.onPrompt((msg) => host.finishTurn(msg.id, 'hello from the new conductor'));
  const created = await callTool(app, 'create_conductor_session');
  await callTool(app, 'send_to_conductor', { text: 'start' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.sessionId, created.session.sessionId);
  assert.equal(ev.data.text, 'hello from the new conductor');
});

test('a turn missed while the host link was down is announced once on reconnect', async (t) => {
  const { host, app, sse } = await setup(t);
  const reopened = new Promise((r) => app.deps.link.once('open', r));
  host.dropConnections();
  host.finishTurn('cond-a', 'finished while you were away', { notify: false });
  await reopened;
  assert.equal((await sse.next('announce')).data.text, 'finished while you were away');
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  assert.equal((await drain(app, sse)).length, 1);
  const hostStates = sse.events.filter((e) => e.event === 'host').map((e) => e.data.connected);
  assert.deepEqual(hostStates.slice(-2), [false, true]);
});

test('a turn finished while the backend was down is announced at startup', async (t) => {
  const host = await startFakeHost({ instances: [CONDUCTOR_A] });
  const first = await startApp({ host });
  await first.deps.service.setTarget('cond-a');
  const sse1 = sseClient(`${first.url}/api/events`);
  await sse1.ready;
  first.deps.sse.publish('marker', {});
  const lastId = (await sse1.next('marker')).id;
  sse1.close();
  await first.stop({ keepRoot: true });

  host.finishTurn('cond-a', 'done during the restart', { notify: false });
  const second = await startApp({ host, projectsRoot: first.root });
  t.after(async () => { await second.stop(); await host.close(); });
  // The page's EventSource reconnects with the previous process's id and
  // gets the startup announcement replayed.
  const sse2 = sseClient(`${second.url}/api/events`, { lastEventId: lastId });
  t.after(() => sse2.close());
  await sse2.ready;
  const ev = await sse2.next('announce');
  assert.equal(ev.data.text, 'done during the restart');
  await second.deps.announcer.reconcile();
  second.deps.sse.publish('marker', {});
  await sse2.next('marker');
  assert.equal(sse2.events.filter((e) => e.event === 'announce').length, 1);
});

test('Last-Event-ID replays only what was missed; a fresh page gets none', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-a', 'one');
  const one = await sse.next('announce');
  host.finishTurn('cond-a', 'two');
  await sse.next('announce', (d) => d.text === 'two');
  const again = sseClient(`${app.url}/api/events`, { lastEventId: one.id });
  const fresh = sseClient(`${app.url}/api/events`);
  t.after(() => { again.close(); fresh.close(); });
  await Promise.all([again.ready, fresh.ready]);
  assert.equal((await again.next('announce')).data.text, 'two');
  app.deps.sse.publish('marker', {});
  await again.next('marker');
  await fresh.next('marker');
  assert.deepEqual(again.events.filter((e) => e.event === 'announce').map((e) => e.data.text), ['two']);
  assert.deepEqual(fresh.events.filter((e) => e.event === 'announce'), []);
  assert.equal(fresh.events[0].event, 'target');
  assert.equal(fresh.events[0].id, undefined, 'initial state does not move Last-Event-ID');
  assert.deepEqual(fresh.events[0].data, { sessionId: 'cond-a', title: 'Alpha plan' });
});

test('a vanished target is cleared', async (t) => {
  const { host, app, sse } = await setup(t);
  host.state.instances.splice(host.state.instances.findIndex((i) => i.id === 'cond-a'), 1);
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  const ev = await sse.next('target', (d) => d === null);
  assert.equal(ev.data, null);
  assert.equal(app.deps.state.get().activeTargetId, null);
});

test('a turn with no text reply is announced as such', async (t) => {
  const { host, sse } = await setup(t);
  host.addEvent('cond-a', { kind: 'turn_end', isError: true });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.text, '(turn finished with no text reply)');
  assert.equal(ev.data.isError, true);
});
