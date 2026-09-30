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
  assert.deepEqual(ev.data, { sessionId: 'cond-a', title: 'Alpha plan', text: 'Done: \nall green', turnSeq: end._seq, isError: false, ask: null });
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

test('a persisted worker id is never announced and is cleared', async (t) => {
  const { host, app, sse } = await setup(t, { active: null });
  await app.deps.state.update({ activeTargetId: 'worker-1', lastHandledTurnSeq: -1 });
  host.finishTurn('worker-1', 'worker output');
  const ev = await sse.next('target', (d) => d === null);
  assert.equal(ev.data, null);
  assert.equal(app.deps.state.get().activeTargetId, null);
  assert.deepEqual(await drain(app, sse), []);
  assert.ok(!host.requests.some((q) => q.url.startsWith('/api/instances/worker-1/')), 'no event read for the worker');
});

test('the announced text is the reply before the turn_end, not the next turn\'s', async (t) => {
  const { host, app, sse } = await setup(t);
  const logged = t.mock.method(console, 'error', () => {});
  host.addEvent('cond-a', { ...reply('reply to turn one'), msgId: 'msg-one' });
  const end = host.addEvent('cond-a', { kind: 'turn_end', isError: false });
  host.addEvent('cond-a', { ...reply('turn two already talking'), msgId: 'msg-two' });
  await app.deps.announcer.reconcile();
  const ev = await sse.next('announce');
  assert.ok(logged.mock.calls.some((c) => /later turn has spoken/.test(String(c.arguments[0]))), 'the stale-turn fallback is logged');
  assert.equal(ev.data.text, 'reply to turn one');
  assert.equal(ev.data.turnSeq, end._seq);
});

test('a persisted worker id is never shown as the target', async (t) => {
  const host = await startFakeHost({ instances: [CONDUCTOR_A, WORKER] });
  const app = await startApp({ host });
  t.after(async () => { await app.stop(); await host.close(); });
  // As if state.json were hand-edited; no reconcile has run since.
  await app.deps.state.update({ activeTargetId: 'worker-1', lastHandledTurnSeq: -1 });
  assert.equal(await app.deps.service.getTarget(), null);
  const sse = sseClient(`${app.url}/api/events`);
  t.after(() => sse.close());
  const first = await sse.next('target');
  assert.equal(first.data, null);
  assert.equal(sse.events[0], first, 'the initial event names no target');
  await app.deps.state.update({ activeTargetId: 'cond-a' });
  assert.deepEqual(await app.deps.service.getTarget(), { sessionId: 'cond-a', title: 'Alpha plan' });
  await host.close();
  assert.equal(await app.deps.service.getTarget(), null, 'unverifiable while the host is down');
});

// ---- questions and plans ----

const QUESTIONS = [
  { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres (Recommended)', description: 'robust' }, { label: 'SQLite', description: 'tiny: embedded' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: 'style' }, { label: 'Test', description: 'unit' }] },
];
const mcpReads = (host) => host.mcpCalls.filter((c) => c.name === 'get_recent_messages');
const announces = (sse) => sse.events.filter((e) => e.event === 'announce').map((e) => e.data);
// Waits until everything published so far has been received.
async function settle(app, sse) {
  app.deps.sse.publish('marker', {});
  await sse.next('marker');
}

test('a turn ending on AskUserQuestion announces its questions with every option and ask.count', async (t) => {
  const { host, app, sse } = await setup(t);
  const end = host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'Two quick things.' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.turnSeq, end._seq);
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.match(ev.data.text, /^Two quick things\.\n--- questions ---\n1\. Which database\? \(multiSelect: false\) · header: DB\n   - Postgres \(Recommended\): robust\n   - SQLite: tiny: embedded\n2\. Which checks\? \(multiSelect: true\) · header: Checks\n   - Lint: style\n   - Test: unit$/);
  assert.deepEqual(mcpReads(host).map((c) => c.arguments), [{ sessionId: 's-a' }], 'read by the host session id, with no count');
  assert.equal(app.deps.state.get().lastHandledMsgId, `m${end._seq - 2}`);
});

test('a turn ending on ExitPlanMode announces the plan with ask.planPath', async (t) => {
  const { host, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: 'Step 1: do it', planPath: '/plans/x.md', prose: 'Here is my plan.' });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data.ask, { kind: 'plan', planPath: '/plans/x.md' });
  assert.equal(ev.data.text, 'Here is my plan.\n--- plan · saved to /plans/x.md ---\nStep 1: do it');
  host.finishAsk('cond-a', { kind: 'plan', plan: 'inline plan', prose: 'Again.' });
  const inline = await sse.next('announce', (d) => d.text.includes('inline plan'));
  assert.deepEqual(inline.data.ask, { kind: 'plan', planPath: null });
});

test('no ask is reported when the row shows no unanswered tool ask (auto-approved, answered, or prose-only)', async (t) => {
  const { host, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: 'auto-approved plan', row: { awaitingUser: null, awaitingUserSource: null } });
  assert.equal((await sse.next('announce')).data.ask, null);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, row: { awaitingUser: 'question', awaitingUserSource: 'text' } });
  const second = await sse.next('announce', (d) => d.text.includes('--- questions ---'));
  assert.equal(second.data.ask, null, 'the text still carries the questions');
  host.finishTurn('cond-a', 'plain reply');
  assert.equal((await sse.next('announce', (d) => d.text === 'plain reply')).data.ask, null);
});

test('a suppressed question turn is announced once, triggered by the instances frame alone', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, notify: false });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  // More instances frames and a late turn_notification change nothing.
  for (let i = 0; i < 3; i++) host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  await drain(app, sse);
  assert.equal(announces(sse).length, 1);
});

test('a suppressed turn without an ask stays silent on instances frames', async (t) => {
  const { host, app, sse } = await setup(t);
  host.requests.length = 0;
  host.finishTurn('cond-a', 'paused while waiting on a worker', { notify: false });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.deepEqual(announces(sse), []);
  assert.equal(mcpReads(host).length, 0, 'nothing was read');
  assert.equal(host.requests.filter((q) => q.url.startsWith('/api/instances/cond-a/events')).length, 0);
  assert.equal(app.deps.state.get().lastHandledTurnSeq, -1, 'state untouched');
});

test('a burst of instances frames costs one MCP read', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, notify: false });
  for (let i = 0; i < 6; i++) host.broadcast({ t: 'instances', instances: host.state.instances });
  await sse.next('announce');
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.equal(mcpReads(host).length, 1);
  assert.equal(announces(sse).length, 1);
});

test('a notified ask turn is read once even though an instances frame arrives too', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: 'p', planPath: '/p.md' });
  await sse.next('announce');
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
  assert.equal(mcpReads(host).length, 1);
});

test('an ask whose turn has not ended is not announced early, then is once the turn ends', async (t) => {
  const { host, app, sse } = await setup(t);
  // The host sets the ask at the tool call; the turn_end lands later.
  host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool', lastResponseAt: 5 });
  host.addEvent('cond-a', { kind: 'assistant_message', msgId: 'early', message: { content: [{ type: 'text', text: 'asking' }] } });
  host.addEvent('cond-a', { kind: 'user_question', toolUseId: 't', questions: QUESTIONS });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.deepEqual(announces(sse), []);
  host.addEvent('cond-a', { kind: 'turn_end', isError: false });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
});

test('when the MCP read fails the text falls back to /events, logged, and the pending ask is rendered from its own event', async (t) => {
  const { host, sse } = await setup(t);
  const logged = t.mock.method(console, 'error', () => {});
  host.setMcp('get_recent_messages', () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'Fallback prose.' });
  const ev = await sse.next('announce');
  assert.match(ev.data.text, /^Fallback prose\.\n--- questions ---\n1\. Which database\?/, 'the events prose plus the questions rendered from the user_question event');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.ok(logged.mock.calls.some((c) => /get_recent_messages failed/.test(String(c.arguments[0]))), 'the degradation is logged');
  host.finishTurn('cond-a', 'plain after failure');
  assert.equal((await sse.next('announce', (d) => d.text === 'plain after failure')).data.ask, null);
});

test('a conductor with no host session id yet falls back to /events', async (t) => {
  const { host, sse } = await setup(t);
  t.mock.method(console, 'error', () => {});
  host.setRow('cond-a', { sessionId: null });
  host.finishTurn('cond-a', 'spawned fast');
  assert.equal((await sse.next('announce')).data.text, 'spawned fast');
  assert.equal(host.mcpCalls.length, 0);
});

test('a host ring reset replays nothing, and the next turn is announced', async (t) => {
  const { host, app, sse } = await setup(t);
  const filler = () => { for (let i = 0; i < 5; i++) host.addEvent('cond-a', { kind: 'tool_use', name: 'Bash' }); };
  filler();
  host.finishTurn('cond-a', 'turn one', { notify: false });
  filler();
  const second = host.finishTurn('cond-a', 'turn two', { notify: false });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.deepEqual(announces(sse).map((a) => a.text), ['turn two']);
  const handled = app.deps.state.get();
  assert.equal(handled.lastHandledTurnSeq, second._seq);
  // Respawn: the history is replayed into a ring with fewer, renumbered events.
  host.resetRing('cond-a', { drop: (ev) => ev.kind === 'tool_use' });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1, 'the replayed turn is not announced again');
  assert.equal(app.deps.state.get().lastHandledTurnSeq, 4, 'the handled seq follows the renumbering');
  assert.equal(app.deps.state.get().lastHandledMsgId, handled.lastHandledMsgId);
  host.finishTurn('cond-a', 'turn three');
  assert.equal((await sse.next('announce', (d) => d.text === 'turn three')).data.turnSeq, 6);
});

test('a replayed turn is silent even when its new _seq is higher than the handled one', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-a', 'already heard', { notify: false });
  await app.deps.announcer.reconcile();
  const heard = app.deps.state.get();
  // Replay under shifted numbering: two extra events up front.
  host.resetRing('cond-a');
  host.state.events['cond-a'] = [{ kind: 'tool_use', _seq: 1 }, { kind: 'tool_use', _seq: 2 }, ...host.state.events['cond-a'].map((ev) => ({ ...ev, _seq: ev._seq + 2 }))];
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
  assert.equal(app.deps.state.get().lastHandledTurnSeq, heard.lastHandledTurnSeq + 2);
});

test('a turn that said nothing is announced even after an announced turn', async (t) => {
  const { host, sse } = await setup(t);
  host.finishTurn('cond-a', 'talked');
  await sse.next('announce');
  host.addEvent('cond-a', { kind: 'turn_end', isError: true });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  const ev = await sse.next('announce', (d) => d.isError);
  assert.equal(ev.data.turnSeq, 3);
});

test('a long reply keeps the questions whole and cuts the prose before them', async (t) => {
  const { host, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'word '.repeat(2000) });
  const ev = await sse.next('announce');
  assert.ok(ev.data.text.length <= 4000);
  assert.match(ev.data.text, /…\n--- questions ---\n1\. Which database\?/);
  assert.ok(ev.data.text.endsWith('   - Lint: style\n   - Test: unit'), 'every option survives');
});

test('switching target records the msgId of its last finished turn', async (t) => {
  const { host, app } = await setup(t, { events: { 'cond-b': [{ kind: 'assistant_message', msgId: 'old-msg', message: { content: [{ type: 'text', text: 'old' }] } }, { kind: 'turn_end' }] } });
  await app.deps.service.setTarget('cond-b');
  assert.equal(app.deps.state.get().lastHandledMsgId, 'old-msg');
  await app.deps.service.setTarget('cond-a');
  assert.equal(app.deps.state.get().lastHandledMsgId, null);
  assert.equal(mcpReads(host).length, 0);
});

// ---- a pending ask that is not the newest turn ----

const eventReads = (host) => host.requests.filter((q) => q.method === 'GET' && q.url.startsWith('/api/instances/cond-a/events')).length;
const listReads = (host) => host.requests.filter((q) => q.method === 'GET' && q.url === '/api/instances').length;
// A conductor that ended on an ask the host did not notify about, then ran a
// later turn (a wake from a worker): the row still shows the unanswered ask.
function askThenLaterTurn(host, ask, later = 'worker finished, carrying on') {
  const askEnd = host.finishAsk('cond-a', { ...ask, notify: false, frames: false });
  const laterEnd = host.finishTurn('cond-a', later, { notify: false });
  return { askEnd, laterEnd };
}

test('a pending question is announced by an instances frame even though a later turn exists', async (t) => {
  const { host, app, sse } = await setup(t);
  const { askEnd } = askThenLaterTurn(host, { kind: 'question', questions: QUESTIONS, prose: 'Two quick things.' });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  const ev = await sse.next('announce');
  assert.equal(ev.data.turnSeq, askEnd._seq, 'the ask\'s own turn, not the later one');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.match(ev.data.text, /^Two quick things\.\n--- questions ---\n1\. Which database\?.*\n {3}- Postgres \(Recommended\): robust\n {3}- SQLite: tiny: embedded\n2\. Which checks\?.*\n {3}- Lint: style\n {3}- Test: unit$/s);
  await settle(app, sse);
  assert.equal(announces(sse).length, 1, 'the suppressed later turn stays silent on an ask-only trigger');
  assert.equal(app.deps.state.get().lastHandledTurnSeq, -1, 'the turn cursor is untouched');
  assert.equal(app.deps.state.get().lastHandledAskId, 'tu1');
});

test('the plain path announces the pending ask first, then the later turn, each once', async (t) => {
  const { host, app, sse } = await setup(t);
  const { askEnd, laterEnd } = askThenLaterTurn(host, { kind: 'question', questions: QUESTIONS });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  const got = announces(sse);
  assert.deepEqual(got.map((a) => [a.turnSeq, a.ask?.kind ?? null]), [[askEnd._seq, 'question'], [laterEnd._seq, null]]);
  assert.equal(got[1].text, 'worker finished, carrying on');
  assert.equal(app.deps.state.get().lastHandledTurnSeq, laterEnd._seq);
  // Duplicate triggers of every kind add nothing.
  host.broadcast({ t: 'instances', instances: host.state.instances });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  await app.deps.announcer.reconcileAsk();
  await drain(app, sse);
  assert.equal(announces(sse).length, 2);
});

test('a pending ask is not announced again after the host renumbers its ring', async (t) => {
  const { host, app, sse } = await setup(t);
  for (let i = 0; i < 6; i++) host.addEvent('cond-a', { kind: 'tool_use', name: 'Bash' });
  askThenLaterTurn(host, { kind: 'question', questions: QUESTIONS });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 2);
  host.resetRing('cond-a', { drop: (ev) => ev.kind === 'tool_use' });
  await app.deps.announcer.reconcile();
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.equal(announces(sse).length, 2, 'the tool_use id keys the ask, so a new _seq does not re-announce it');
});

test('a pending plan behind a later turn is announced from its plan_request event', async (t) => {
  const { host, app, sse } = await setup(t);
  const { askEnd } = askThenLaterTurn(host, { kind: 'plan', plan: 'Step 1: do it', planPath: '/plans/x.md', prose: 'Plan below.' });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  const ev = await sse.next('announce');
  assert.equal(ev.data.turnSeq, askEnd._seq);
  assert.deepEqual(ev.data.ask, { kind: 'plan', planPath: '/plans/x.md' });
  assert.equal(ev.data.text, 'Plan below.\n--- plan · saved to /plans/x.md ---\nStep 1: do it');
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
});

test('a second ask after the first was announced is announced too', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'first', notify: false });
  await sse.next('announce', (d) => d.text.startsWith('first'));
  host.finishAsk('cond-a', { kind: 'question', questions: [QUESTIONS[0]], prose: 'second', notify: false });
  const second = await sse.next('announce', (d) => d.text.startsWith('second'));
  assert.deepEqual(second.data.ask, { kind: 'question', count: 1 });
  await settle(app, sse);
  assert.equal(announces(sse).length, 2);
});

test('an ask the session already ended on when it became the target is not announced', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-b', { kind: 'question', questions: QUESTIONS, notify: false, frames: false });
  await app.deps.service.setTarget('cond-b');
  assert.equal(app.deps.state.get().lastHandledAskId, 'tu1');
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.deepEqual(announces(sse), []);
});

// ---- sub-agent messages ----

test('a sub-agent message between the question and turn_end does not change the turn\'s msgId or text', async (t) => {
  const { host, app, sse } = await setup(t);
  const logged = t.mock.method(console, 'error', () => {});
  host.addEvent('cond-a', { kind: 'assistant_message', msgId: 'main-1', message: { content: [{ type: 'text', text: 'Two quick things.' }] } });
  host.addEvent('cond-a', { kind: 'user_question', toolUseId: 'toolu_q', questions: QUESTIONS });
  host.addEvent('cond-a', { kind: 'assistant_message', msgId: 'sub-1', parentToolUseId: 'toolu_task', message: { content: [{ type: 'text', text: 'sub-agent chatter' }] } });
  const end = host.addEvent('cond-a', { kind: 'turn_end', isError: false });
  host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool', lastResponseAt: 9 });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.turnSeq, end._seq);
  assert.doesNotMatch(ev.data.text, /sub-agent chatter/);
  assert.match(ev.data.text, /^Two quick things\.\n--- questions ---/, 'the host\'s own rendering, so the stale-turn guard accepted it');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.equal(app.deps.state.get().lastHandledMsgId, 'main-1');
  assert.ok(!logged.mock.calls.some((c) => /later turn has spoken/.test(String(c.arguments[0]))), 'no stale-turn fallback');
});

test('a sub-agent turn_end is not a turn of the conductor', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-a', 'real turn', { notify: false });
  await app.deps.announcer.reconcile();
  const handled = app.deps.state.get();
  host.addEvent('cond-a', { kind: 'turn_end', parentToolUseId: 'toolu_task', isError: false });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
  assert.deepEqual(app.deps.state.get(), handled);
});

// ---- latching ----

test('an unchanged ask state costs one events read and one MCP read, however many instances frames follow', async (t) => {
  const { host, app, sse } = await setup(t);
  host.requests.length = 0;
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, notify: false });
  for (let i = 0; i < 6; i++) host.broadcast({ t: 'instances', instances: host.state.instances });
  await sse.next('announce');
  await app.deps.announcer.reconcileAsk();
  assert.equal(eventReads(host), 1);
  assert.equal(mcpReads(host).length, 1);
  const lists = listReads(host);
  for (let i = 0; i < 5; i++) await app.deps.announcer.reconcileAsk();
  assert.equal(eventReads(host), 1, 'later frames read only the instance list');
  assert.equal(mcpReads(host).length, 1);
  assert.equal(listReads(host), lists + 5);
  assert.equal(announces(sse).length, 1);
});

test('a row ask with no matching event settles after one probe; a new ask state probes again', async (t) => {
  const { host, app, sse } = await setup(t);
  host.requests.length = 0;
  // The row claims an ask, but the events window holds no such event.
  host.setRow('cond-a', { awaitingUser: 'plan', awaitingUserSource: 'tool', lastResponseAt: 50 });
  for (let i = 0; i < 4; i++) await app.deps.announcer.reconcileAsk();
  assert.equal(eventReads(host), 1);
  assert.equal(mcpReads(host).length, 0);
  // A different ask state is probed, and a real ask is then announced.
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, notify: false, frames: false });
  await app.deps.announcer.reconcileAsk();
  assert.equal(eventReads(host), 2);
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
});

// ---- oversized questions ----

const BIG = Array.from({ length: 10 }, (_, q) => ({
  question: `Question ${q + 1}?`,
  header: `H${q + 1}`,
  multiSelect: false,
  options: Array.from({ length: 6 }, (_, o) => ({ label: `Q${q + 1}-Option-${o + 1}`, description: 'long description '.repeat(12) })),
}));

test('an oversized questions section keeps every label, is flagged truncated, and ask.count stays true', async (t) => {
  const { host, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: BIG, prose: 'Lots of questions.' });
  const ev = await sse.next('announce');
  assert.ok(ev.data.text.length <= 4000);
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 10, truncated: true });
  for (let q = 1; q <= 10; q++) for (let o = 1; o <= 6; o++) assert.ok(ev.data.text.includes(`Q${q}-Option-${o}`), `Q${q}-Option-${o}`);
  assert.ok(ev.data.text.includes('…'), 'descriptions were shortened');
});

test('a questions section that fits is not flagged', async (t) => {
  const { host, sse } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'word '.repeat(2000) });
  assert.deepEqual((await sse.next('announce')).data.ask, { kind: 'question', count: 2 });
});
