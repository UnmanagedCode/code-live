// Pins: every finished turn of an announced conductor (one this backend has
// acted on) is announced over SSE exactly once, with its own session id,
// including turns whose notification was missed (host /ws down, backend
// restarted, or a fast turn right after the first send), while old turns,
// conductors never acted on and duplicate notifications stay silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startFakeHost, mcpOk, mcpThrown } from './fakes/fakeHost.mjs';
import { startApp, sseClient, callTool, waitFor, tempDir, CONDUCTOR_A, CONDUCTOR_B, WORKER } from './helpers.mjs';

const reply = (text) => ({ kind: 'assistant_message', message: { content: [{ type: 'text', text }] } });

const cursor = (app, id = 'cond-a') => app.deps.state.get().watched[id];

async function setup(t, { events = {}, watch = ['cond-a'], baseline = true } = {}) {
  const host = await startFakeHost({ instances: [CONDUCTOR_A, CONDUCTOR_B, WORKER], events });
  const app = await startApp({ host });
  for (const id of watch) {
    if (baseline) await app.deps.announcer.watch(id);
    else await app.deps.state.update({ watched: { ...app.deps.state.get().watched, [id]: { lastHandledTurnSeq: -1, lastHandledMsgId: null, lastHandledAskId: null } } });
  }
  const sse = sseClient(`${app.url}/api/events`);
  await sse.ready;
  await sse.next('host');
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

test('a turn_notification for an announced conductor announces its last text reply', async (t) => {
  const { host, app, sse } = await setup(t);
  host.addEvent('cond-a', reply('thinking out loud'));
  host.addEvent('cond-a', { kind: 'assistant_message', message: { content: [{ type: 'text', text: 'Done: ' }, { type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: 'all green' }] } });
  host.addEvent('cond-a', { kind: 'assistant_message', message: { content: [{ type: 'tool_use', id: 'u', name: 'y', input: {} }] } });
  const end = host.addEvent('cond-a', { kind: 'turn_end', isError: false });
  host.broadcast({ t: 'turn_notification', id: 'cond-a', project: '.conduct', isError: false });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data, { sessionId: 'cond-a', title: 'Alpha plan', text: 'Done: \nall green', turnSeq: end._seq, isError: false, ask: null });
  assert.match(ev.id, /^[0-9a-f]+-\d+$/);
  assert.equal(cursor(app).lastHandledTurnSeq, end._seq);
});

test('conductors never acted on, and duplicate notifications, are not announced', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-b', 'never acted on');
  host.finishTurn('cond-a', 'the announced one');
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  await waitFor(() => host.requests.filter((q) => q.url.startsWith('/api/instances/cond-a/events')).length >= 3);
  const announced = await drain(app, sse);
  assert.deepEqual(announced.map((a) => a.text), ['the announced one']);
});

test('the first send to a conductor baselines it: its earlier turns stay silent', async (t) => {
  const { host, app, sse } = await setup(t, { events: { 'cond-b': [reply('old news'), { kind: 'turn_end' }] } });
  const r = await callTool(app, 'send_to_conductor', { session: 'cond-b', text: 'go' });
  assert.equal(r.ok, true);
  host.broadcast({ t: 'turn_notification', id: 'cond-b' });
  assert.deepEqual(await drain(app, sse), []);
  host.finishTurn('cond-b', 'fresh news');
  const ev = await sse.next('announce');
  assert.equal(ev.data.text, 'fresh news');
  assert.equal(ev.data.sessionId, 'cond-b');
});

test('a turn that ends right after the first send to a conductor is still announced', async (t) => {
  const { host, app, sse } = await setup(t, { events: { 'cond-b': [reply('old news'), { kind: 'turn_end' }] } });
  // The host finishes the turn (and notifies) before it even acks the prompt.
  host.onPrompt((msg) => host.finishTurn(msg.id, `reply to ${msg.text}`));
  const r = await callTool(app, 'send_to_conductor', { text: 'go', session: 'cond-b' });
  assert.equal(r.ok, true);
  const ev = await sse.next('announce');
  assert.equal(ev.data.sessionId, 'cond-b');
  assert.equal(ev.data.text, 'reply to go');
  assert.deepEqual((await drain(app, sse)).map((a) => a.text), ['reply to go']);
});

test('a create followed by a fast first turn is announced', async (t) => {
  const { host, app, sse } = await setup(t, { watch: [] });
  host.onPrompt((msg) => host.finishTurn(msg.id, 'hello from the new conductor'));
  const created = await callTool(app, 'create_conductor_session');
  await callTool(app, 'send_to_conductor', { text: 'start', session: created.session.sessionId });
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
  await first.deps.announcer.watch('cond-a');
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

test('?lastEventId= replays like the Last-Event-ID header, and the header wins when both are sent', async (t) => {
  // Pins: a page whose EventSource was re-created after a 502/503 (it cannot
  // set a header) still gets what it missed, from the query parameter; with
  // both, the header's (newer) id decides.
  const host = await startFakeHost({ instances: [CONDUCTOR_A] });
  const first = await startApp({ host });
  await first.deps.announcer.watch('cond-a');
  const sse1 = sseClient(`${first.url}/api/events`);
  await sse1.ready;
  first.deps.sse.publish('marker', {});
  const oldBootId = (await sse1.next('marker')).id;
  sse1.close();
  await first.stop({ keepRoot: true });

  host.finishTurn('cond-a', 'during the restart', { notify: false });
  const second = await startApp({ host, projectsRoot: first.root });
  t.after(async () => { await second.stop(); await host.close(); });
  const viaQuery = sseClient(`${second.url}/api/events?lastEventId=${encodeURIComponent(oldBootId)}`);
  t.after(() => viaQuery.close());
  await viaQuery.ready;
  assert.equal((await viaQuery.next('announce')).data.text, 'during the restart');
  const startupId = viaQuery.events.find((e) => e.event === 'announce').id;

  // The header's id (this boot, already past the announcement) outranks the query's old-boot id.
  const both = sseClient(`${second.url}/api/events?lastEventId=${encodeURIComponent(oldBootId)}`, { lastEventId: startupId });
  t.after(() => both.close());
  await both.ready;
  second.deps.sse.publish('marker', {});
  await both.next('marker');
  assert.deepEqual(both.events.filter((e) => e.event === 'announce'), []);
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
  assert.equal(fresh.events[0].event, 'host');
  assert.equal(fresh.events[0].id, undefined, 'initial state does not move Last-Event-ID');
  assert.deepEqual(fresh.events[0].data, { connected: true });
});

test('a vanished conductor is pruned from the announced set by an instances frame', async (t) => {
  const { host, app, sse } = await setup(t);
  host.state.instances.splice(host.state.instances.findIndex((i) => i.id === 'cond-a'), 1);
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await waitFor(() => cursor(app) === undefined, { what: 'the vanished conductor to be pruned' });
  assert.deepEqual(app.deps.state.get().watched, {});
  assert.deepEqual(await drain(app, sse), []);
});

test('a turn with no text reply is announced as such', async (t) => {
  const { host, sse } = await setup(t);
  host.addEvent('cond-a', { kind: 'turn_end', isError: true });
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.text, '(turn finished with no text reply)');
  assert.equal(ev.data.isError, true);
});

test('a persisted worker id in the announced set is never read and is pruned', async (t) => {
  const { host, app, sse } = await setup(t, { watch: [] });
  await app.deps.state.update({ watched: { 'worker-1': { lastHandledTurnSeq: -1, lastHandledMsgId: null, lastHandledAskId: null } } });
  host.finishTurn('worker-1', 'worker output');
  await waitFor(() => cursor(app, 'worker-1') === undefined, { what: 'the worker id to be pruned' });
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
  assert.equal(cursor(app).lastHandledMsgId, `m${end._seq - 2}`);
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
  assert.equal(cursor(app).lastHandledTurnSeq, -1, 'state untouched');
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
  const handled = cursor(app);
  assert.equal(handled.lastHandledTurnSeq, second._seq);
  // Respawn: the history is replayed into a ring with fewer, renumbered events.
  host.resetRing('cond-a', { drop: (ev) => ev.kind === 'tool_use' });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1, 'the replayed turn is not announced again');
  assert.equal(cursor(app).lastHandledTurnSeq, 4, 'the handled seq follows the renumbering');
  assert.equal(cursor(app).lastHandledMsgId, handled.lastHandledMsgId);
  host.finishTurn('cond-a', 'turn three');
  assert.equal((await sse.next('announce', (d) => d.text === 'turn three')).data.turnSeq, 6);
});

test('a replayed turn is silent even when its new _seq is higher than the handled one', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-a', 'already heard', { notify: false });
  await app.deps.announcer.reconcile();
  const heard = cursor(app);
  // Replay under shifted numbering: two extra events up front.
  host.resetRing('cond-a');
  host.state.events['cond-a'] = [{ kind: 'tool_use', _seq: 1 }, { kind: 'tool_use', _seq: 2 }, ...host.state.events['cond-a'].map((ev) => ({ ...ev, _seq: ev._seq + 2 }))];
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
  assert.equal(cursor(app).lastHandledTurnSeq, heard.lastHandledTurnSeq + 2);
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

test('watching a conductor records the msgId of its last finished turn; watching again keeps the cursor', async (t) => {
  const { host, app } = await setup(t, { events: { 'cond-b': [{ kind: 'assistant_message', msgId: 'old-msg', message: { content: [{ type: 'text', text: 'old' }] } }, { kind: 'turn_end' }] } });
  await app.deps.announcer.watch('cond-b');
  assert.equal(cursor(app, 'cond-b').lastHandledMsgId, 'old-msg');
  assert.equal(cursor(app).lastHandledMsgId, null);
  host.finishTurn('cond-b', 'newer', { notify: false });
  await app.deps.announcer.watch('cond-b');
  assert.equal(cursor(app, 'cond-b').lastHandledMsgId, 'old-msg', 'a second watch does not re-baseline');
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
  assert.equal(cursor(app).lastHandledTurnSeq, -1, 'the turn cursor is untouched');
  assert.equal(cursor(app).lastHandledAskId, 'tu1');
});

test('the plain path announces the pending ask first, then the later turn, each once', async (t) => {
  const { host, app, sse } = await setup(t);
  const { askEnd, laterEnd } = askThenLaterTurn(host, { kind: 'question', questions: QUESTIONS });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  const got = announces(sse);
  assert.deepEqual(got.map((a) => [a.turnSeq, a.ask?.kind ?? null]), [[askEnd._seq, 'question'], [laterEnd._seq, null]]);
  assert.equal(got[1].text, 'worker finished, carrying on');
  assert.equal(cursor(app).lastHandledTurnSeq, laterEnd._seq);
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

test('the first send to a conductor already blocked on an ask announces that ask once, but not its old turns', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-b', 'old news', { notify: false });
  const askEnd = host.finishAsk('cond-b', { kind: 'question', questions: QUESTIONS, prose: 'Blocked on you.', notify: false, frames: false });
  await callTool(app, 'send_to_conductor', { session: 'cond-b', text: 'status?' });
  const ev = await sse.next('announce');
  assert.equal(ev.data.sessionId, 'cond-b');
  assert.equal(ev.data.turnSeq, askEnd._seq);
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.match(ev.data.text, /^Blocked on you\.\n--- questions ---/);
  // Sending again and every further trigger add nothing.
  await callTool(app, 'send_to_conductor', { session: 'cond-b', text: 'again' });
  await app.deps.announcer.reconcileAsk();
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  const all = announces(sse);
  assert.equal(all.length, 1);
  assert.ok(all.every((a) => !a.text.includes('old news')), 'finished turns are not replayed on the first send');
});

test('an ask answered before a conductor is first acted on is not announced', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-b', { kind: 'question', questions: QUESTIONS, notify: false, frames: false });
  host.setRow('cond-b', { awaitingUser: null, awaitingUserSource: null });
  await app.deps.announcer.watch('cond-b');
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.deepEqual(announces(sse), []);
});

test('asks pending on two announced conductors are both announced from one instances frame', async (t) => {
  const { host, app, sse } = await setup(t, { watch: ['cond-a', 'cond-b'] });
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'A asks.', notify: false, frames: false });
  host.finishAsk('cond-b', { kind: 'plan', plan: 'Step 1', planPath: '/plans/b.md', prose: 'B plans.', notify: false, frames: false });
  host.requests.length = 0;
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await sse.next('announce', (d) => d.sessionId === 'cond-a');
  await sse.next('announce', (d) => d.sessionId === 'cond-b');
  await settle(app, sse);
  const got = announces(sse);
  assert.deepEqual(got.map((a) => [a.sessionId, a.ask.kind]), [['cond-a', 'question'], ['cond-b', 'plan']]);
  assert.equal(listReads(host), 1, 'one instance-list read serves both conductors');
});

test('two announced conductors each get their turns announced with their own session id', async (t) => {
  const { host, app, sse } = await setup(t, { watch: ['cond-a', 'cond-b'] });
  // A's announcement is held open while both turns finish.
  let release;
  const held = new Promise((r) => { release = r; });
  host.setMcp('get_recent_messages', async (args) => {
    if (args.sessionId === 's-a') await held;
    return mcpThrown('unavailable');
  });
  t.mock.method(console, 'error', () => {});
  host.finishTurn('cond-a', 'from alpha');
  await waitFor(() => host.mcpCalls.some((c) => c.arguments.sessionId === 's-a'), { what: 'A\'s message read to start' });
  host.finishTurn('cond-b', 'from beta');
  release();
  await sse.next('announce', (d) => d.sessionId === 'cond-b');
  await settle(app, sse);
  const got = announces(sse);
  assert.deepEqual(got.map((a) => [a.sessionId, a.text]), [['cond-a', 'from alpha'], ['cond-b', 'from beta']]);
  assert.equal(got[0].title, 'Alpha plan');
});

test('parallel first sends to two conductors announce both replies', async (t) => {
  const { host, app, sse } = await setup(t, { watch: [] });
  host.onPrompt((msg) => host.finishTurn(msg.id, `reply to ${msg.id}`));
  const [a, b] = await Promise.all([
    callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'one' }),
    callTool(app, 'send_to_conductor', { session: 'cond-b', text: 'two' }),
  ]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  await sse.next('announce', (d) => d.sessionId === 'cond-a');
  await sse.next('announce', (d) => d.sessionId === 'cond-b');
  await settle(app, sse);
  assert.deepEqual(announces(sse).map((x) => [x.sessionId, x.text]).sort(), [['cond-a', 'reply to cond-a'], ['cond-b', 'reply to cond-b']]);
});

test('answering a conductor not yet announced starts announcing it without re-announcing the answered question', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishAsk('cond-b', { kind: 'question', questions: QUESTIONS, prose: 'Blocked.', notify: false, frames: false });
  host.setMcp('answer_question', (args) => mcpOk({ sessionId: args.sessionId, mode: 'plan', sentText: 't' }));
  // The row still shows the ask while the answer is delivered.
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-b', answers: [{ choices: ['1'] }, { choices: ['1'] }] });
  assert.equal(r.ok, true);
  assert.ok(cursor(app, 'cond-b'), 'the answered conductor is now announced');
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.deepEqual(announces(sse), [], 'the answered question is not announced');
  host.setRow('cond-b', { awaitingUser: null, awaitingUserSource: null });
  host.finishTurn('cond-b', 'carrying on');
  const ev = await sse.next('announce');
  assert.deepEqual([ev.data.sessionId, ev.data.text], ['cond-b', 'carrying on']);
});

test('answering an already-announced conductor marks its unreconciled ask handled', async (t) => {
  const { host, app, sse } = await setup(t);
  await app.deps.announcer.reconcile(); // flushes the ask reconcile that watching queued
  // The ask lands with no /ws frame, so nothing has reconciled it when the answer goes out.
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'Blocked.', notify: false, frames: false });
  host.setMcp('answer_question', (args) => mcpOk({ sessionId: args.sessionId, mode: 'plan', sentText: 't' }));
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }, { choices: ['1'] }] });
  assert.equal(r.ok, true);
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await app.deps.announcer.reconcileAsk();
  await settle(app, sse);
  assert.deepEqual(announces(sse), [], 'the row still shows the answered question; it is not announced');
});

test('a failed host write puts the ask back: the question or plan is announced again', async (t) => {
  const { host, app, sse } = await setup(t);
  t.mock.method(console, 'error', () => {});
  await app.deps.announcer.reconcile(); // flushes the ask reconcile that watching queued
  host.setMcp('answer_question', () => mcpThrown('kaboom'));
  host.setMcp('reject_plan', () => mcpThrown('kaboom'));
  const failed = async (name, args, session) => {
    const r = await callTool(app, name, { session, ...args });
    assert.deepEqual([r.ok, r.code], [false, 'HOST_MCP_ERROR'], name);
  };
  // An already-announced conductor and one first acted on by the failing call.
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'A asks.', notify: false, frames: false });
  host.finishAsk('cond-b', { kind: 'plan', plan: 'Step 1', planPath: '/plans/b.md', prose: 'B plans.', notify: false, frames: false });
  await failed('answer_conductor_question', { answers: [{ choices: ['1'] }, { choices: ['1'] }] }, 'cond-a');
  const a = await sse.next('announce', (d) => d.sessionId === 'cond-a');
  assert.deepEqual(a.data.ask, { kind: 'question', count: 2 });
  assert.equal(cursor(app, 'cond-b'), undefined);
  await failed('reject_conductor_plan', { feedback: 'smaller' }, 'cond-b');
  const b = await sse.next('announce', (d) => d.sessionId === 'cond-b');
  assert.deepEqual(b.data.ask, { kind: 'plan', planPath: '/plans/b.md' });
  assert.ok(cursor(app, 'cond-b'), 'the conductor stays announced');
  await settle(app, sse);
  assert.equal(announces(sse).length, 2, 'each ask is announced once');
});

test('an undo leaves a newer ask announced while the write was in flight handled, and announces nothing twice', async (t) => {
  const { host, app, sse } = await setup(t);
  t.mock.method(console, 'error', () => {});
  await app.deps.announcer.reconcile(); // flushes the ask reconcile that watching queued
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'First.', notify: false, frames: false });
  let release;
  const held = new Promise((r) => { release = r; });
  host.setMcp('answer_question', async () => { await held; return mcpThrown('kaboom'); });
  const failing = callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }, { choices: ['1'] }] });
  await waitFor(() => host.mcpCalls.some((c) => c.name === 'answer_question'), { what: 'the answer write to start' });
  // While the write is in flight a newer question lands and is announced.
  host.finishAsk('cond-a', { kind: 'question', questions: [QUESTIONS[0]], prose: 'Third.', notify: false, frames: false });
  await app.deps.announcer.reconcileAsk();
  await sse.next('announce', (d) => d.text.startsWith('Third.'));
  release();
  assert.equal((await failing).code, 'HOST_MCP_ERROR');
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  const newest = host.state.events['cond-a'].findLast((e) => e.kind === 'user_question').toolUseId;
  assert.equal(cursor(app).lastHandledAskId, newest, 'the undo did not restore the older mark');
  assert.deepEqual(announces(sse).map((a) => a.text.split('\n')[0]), ['Third.'], 'the newer ask is announced once and the answered one not at all');
});

test('a conductor whose events route 404s while still listed is pruned from the announced set', async (t) => {
  const { host, app, sse } = await setup(t, { watch: ['cond-a', 'cond-b'] });
  host.state.eventsGone.add('cond-a');
  host.broadcast({ t: 'turn_notification', id: 'cond-a' });
  await waitFor(() => cursor(app, 'cond-a') === undefined, { what: 'the 404ing conductor to be pruned' });
  assert.ok(host.state.instances.some((i) => i.id === 'cond-a'), 'its row is still listed');
  assert.deepEqual(Object.keys(app.deps.state.get().watched), ['cond-b'], 'other conductors are kept');
  host.finishTurn('cond-b', 'still announced');
  assert.equal((await sse.next('announce')).data.sessionId, 'cond-b');
});

test('a legacy state.json with an active target announces nothing', async (t) => {
  const host = await startFakeHost({ instances: [CONDUCTOR_A] });
  const root = await tempDir();
  await fs.mkdir(path.join(root, '.code-live'), { recursive: true });
  await fs.writeFile(path.join(root, '.code-live', 'state.json'), JSON.stringify({ activeTargetId: 'cond-a', lastHandledTurnSeq: -1, lastHandledMsgId: null, lastHandledAskId: null }));
  const app = await startApp({ host, projectsRoot: root });
  t.after(async () => { await app.stop(); await host.close(); });
  const sse = sseClient(`${app.url}/api/events`);
  t.after(() => sse.close());
  await sse.ready;
  assert.deepEqual(app.deps.state.get(), { watched: {} });
  host.finishTurn('cond-a', 'nobody asked for this');
  await drain(app, sse);
  assert.deepEqual(announces(sse), []);
  await callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'now' });
  assert.deepEqual(Object.keys(app.deps.state.get().watched), ['cond-a']);
  assert.equal('activeTargetId' in JSON.parse(await fs.readFile(app.deps.state.file, 'utf8')), false, 'the next write drops the legacy fields');
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
  assert.equal(cursor(app).lastHandledMsgId, 'main-1');
  assert.ok(!logged.mock.calls.some((c) => /later turn has spoken/.test(String(c.arguments[0]))), 'no stale-turn fallback');
});

test('a sub-agent turn_end is not a turn of the conductor', async (t) => {
  const { host, app, sse } = await setup(t);
  host.finishTurn('cond-a', 'real turn', { notify: false });
  await app.deps.announcer.reconcile();
  const handled = cursor(app);
  host.addEvent('cond-a', { kind: 'turn_end', parentToolUseId: 'toolu_task', isError: false });
  await app.deps.announcer.reconcile();
  await settle(app, sse);
  assert.equal(announces(sse).length, 1);
  assert.deepEqual(cursor(app), handled);
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

// ---- unhandled rejections ----

// Collects process-level unhandled rejections for the test's duration.
function watchRejections(t) {
  const seen = [];
  const on = (e) => seen.push(e);
  process.on('unhandledRejection', on);
  t.after(() => process.off('unhandledRejection', on));
  return seen;
}
const ticks = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

test('a malformed user_question payload is announced without throwing or rejecting unhandled', async (t) => {
  const { host, sse } = await setup(t);
  const rejections = watchRejections(t);
  t.mock.method(console, 'error', () => {});
  // The event is what the announcer renders when the host's own rendering is unavailable.
  host.setMcp('get_recent_messages', () => ({ content: [{ type: 'text', text: 'unavailable' }], isError: true }));
  host.finishAsk('cond-a', { kind: 'question', questions: [{ question: 'Pick?', options: [null, { label: 'A' }, 7] }, null], prose: 'Odd payload.' });
  const ev = await sse.next('announce');
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 2 });
  assert.match(ev.data.text, /^Odd payload\.\n--- questions ---\n1\. Pick\? \(multiSelect: false\)\n {3}- \n {3}- A\n {3}- \n2\. {2}\(multiSelect: false\)$/);
  await ticks();
  assert.deepEqual(rejections, []);
});

test('a reconcile that throws is logged by every trigger, never left unhandled', async (t) => {
  const { host, app } = await setup(t);
  const rejections = watchRejections(t);
  const logged = t.mock.method(console, 'error', () => {});
  app.deps.state.update = async () => { throw new Error('disk full'); };
  const failures = () => logged.mock.calls.filter((c) => c.arguments[0] === 'code-live: reconcile failed:' && c.arguments[1] === 'disk full').length;
  // turn_notification
  host.finishTurn('cond-a', 'first');
  await waitFor(() => failures() >= 1, { what: 'a logged failure for turn_notification' });
  // host link reopen
  const before = failures();
  host.dropConnections();
  await waitFor(() => failures() > before, { what: 'a logged failure for link open' });
  // instances frame, with a pending ask so the ask-only run gets as far as writing
  const afterOpen = failures();
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, notify: false, frames: false });
  host.broadcast({ t: 'instances', instances: host.state.instances });
  await waitFor(() => failures() > afterOpen, { what: 'a logged failure for instances' });
  // the direct entry point used at startup
  const beforeDirect = failures();
  await app.deps.announcer.reconcileLogged();
  assert.ok(failures() > beforeDirect);
  await ticks();
  assert.deepEqual(rejections, []);
});

// ---- dropped options ----

test('a questions section too big even for bare labels is announced as missing options, not merely shortened', async (t) => {
  const { host, sse } = await setup(t);
  const many = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: Array.from({ length: 400 }, (_, i) => ({ label: `Opt ${i}`, description: 'desc '.repeat(20) })) }];
  host.finishAsk('cond-a', { kind: 'question', questions: many, prose: 'Pick one.' });
  const ev = await sse.next('announce');
  assert.ok(ev.data.text.length <= 4000);
  assert.deepEqual(ev.data.ask, { kind: 'question', count: 1, truncated: true, dropped: true });
  assert.match(ev.data.text, /\n… \d+ more line\(s\) not shown$/);
});
