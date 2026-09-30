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

test("list reports the host's run state: idle only when nothing is in flight", async (t) => {
  const row = (id, status, displayStatus, activeAgentTasks, awaitingWake) => (
    { ...CONDUCTOR_A, id, title: id, status, displayStatus, activeAgentTasks, awaitingWake }
  );
  const rows = [
    row('waiting', 'idle', 'idle', 0, true),
    row('subagents', 'idle', 'running', 2, false),
    row('both', 'idle', 'running', 1, true),
    row('idle', 'idle', 'idle', 0, false),
    row('turn-wake', 'turn', 'turn', 0, true),
  ];
  const { app } = await setup(t, { instances: rows });
  const r = await callTool(app, 'list_conductor_sessions');
  assert.deepEqual(r.sessions.map((s) => [s.sessionId, s.status]), [
    ['waiting', 'on a worker'],
    ['subagents', 'running'],
    ['both', 'running'],
    ['idle', 'idle'],
    ['turn-wake', 'turn'],
  ]);
  const ui = await req(`${app.url}/api/conductors`);
  assert.deepEqual(ui.json, r, 'the target picker shows the same run states');
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
  assert.deepEqual(app.deps.state.get(), { activeTargetId: 'new-conductor-1', lastHandledTurnSeq: -1, lastHandledMsgId: null, lastHandledAskId: null });
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
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments]), [['get_recent_messages', { sessionId: 's-b', count: 2 }]]);
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

// ---- answering questions and deciding plans ----

import { mcpOk, mcpSoft, mcpThrown } from './fakes/fakeHost.mjs';

const QUESTIONS = [
  { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres (Recommended)', description: 'robust' }, { label: 'SQLite', description: 'tiny' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: 'style' }, { label: 'Test', description: 'unit' }] },
];
const called = (host, name) => host.mcpCalls.filter((c) => c.name === name);

// An active conductor stopped on a question or plan, with no /ws frames so the
// announcer stays out of the MCP call log.
async function askSetup(t, kind, opts = {}) {
  const ctx = await setup(t, { active: 'cond-a' });
  ctx.host.finishAsk('cond-a', { kind, questions: QUESTIONS, plan: 'The plan.', planPath: '/plans/p.md', frames: false, ...opts });
  ctx.host.mcpCalls.length = 0;
  return ctx;
}

test('answer maps spoken choices to exact labels and sends them under the row sessionId', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'bypassPermissions', sentText: 'answers' }));
  const r = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['sqlite'] }, { choices: ['1', 'test'], note: 'fast' }] });
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments), [
    { sessionId: 's-a', answers: [{ option: 'SQLite' }, { options: ['Lint', 'Test'], note: 'fast' }] },
  ]);
  assert.deepEqual(r, {
    ok: true,
    sessionId: 'cond-a',
    title: 'Alpha plan',
    delivered: true,
    answered: [{ question: 1, answer: ['SQLite'] }, { question: 2, answer: ['Lint', 'Test'] }],
    note: 'The reply will be announced when the conductor finishes its turn.',
  });
  assert.ok(host.mcpCalls.every((c) => c.arguments.sessionId !== 'cond-a'), 'the instance id is never sent to the MCP tools');
  // A number, free text and a skipped trailing question.
  await callTool(app, 'answer_conductor_question', { answers: [{ choices: [2] }, { text: 'all of them' }] });
  assert.deepEqual(called(host, 'answer_question')[1].arguments.answers, [{ option: 'SQLite' }, { text: 'all of them' }]);
  await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] });
  assert.deepEqual(called(host, 'answer_question')[2].arguments.answers, [{ option: 'Postgres (Recommended)' }, {}], 'missing trailing entries are skipped');
});

test('the MCP session id is read from the live row on every call; a row without one is SESSION_NOT_READY', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  host.setMcp('answer_question', () => mcpOk({ sessionId: 'x', mode: 'plan', sentText: 't' }));
  await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] });
  host.setRow('cond-a', { sessionId: 's-a-renewed' });
  await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] });
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments.sessionId), ['s-a', 's-a-renewed']);
  host.setRow('cond-a', { sessionId: null });
  host.mcpCalls.length = 0;
  for (const [name, args] of [['answer_conductor_question', { answers: [{ choices: ['1'] }] }], ['reject_conductor_plan', {}], ['approve_conductor_plan', { confirmed: true }]]) {
    assert.equal((await callTool(app, name, args)).code, 'SESSION_NOT_READY', name);
  }
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(JSON.stringify(app.deps.state.get()).includes('s-a'), false, 'the host session id is never persisted');
});

test('answer is refused without a pending tool question, before any host call', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  assert.equal((await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] })).code, 'NO_PENDING_QUESTION');
  for (const row of [{ awaitingUser: 'plan', awaitingUserSource: 'tool' }, { awaitingUser: 'question', awaitingUserSource: 'text' }, { awaitingUser: null, awaitingUserSource: null }]) {
    host.setRow('cond-a', row);
    assert.equal((await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] })).code, 'NO_PENDING_QUESTION', JSON.stringify(row));
  }
  assert.equal(host.mcpCalls.length, 0, 'the host would have answered the stale question');
});

test('a host INVALID_OPTION is retried exactly once against the labels the host offers', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  let n = 0;
  host.setMcp('answer_question', (args) => (++n === 1
    ? mcpSoft('INVALID_OPTION', 'not offered', { questionIndex: 0, invalid: ['Sqlite'], offered: ['Postgres 16', 'SQLite 3'] })
    : mcpOk({ sessionId: 's-a', mode: 'plan', sentText: JSON.stringify(args.answers) })));
  const r = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['sqlite'] }, { choices: ['Lint'] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments.answers), [
    [{ option: 'SQLite' }, { options: ['Lint'] }],
    [{ option: 'SQLite 3' }, { options: ['Lint'] }],
  ]);
  assert.deepEqual(r.answered[0], { question: 1, answer: ['SQLite 3'] });
});

test('a choice that still does not resolve is handed back with the offered options', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  // Refused locally: no host call at all.
  const local = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['mongo'] }] });
  assert.deepEqual([local.ok, local.code, local.question, local.offered], [false, 'INVALID_OPTION', 1, ['Postgres (Recommended)', 'SQLite']]);
  assert.equal(called(host, 'answer_question').length, 0);
  // The host's labels differ and the words match none of them: one retry is not even possible.
  host.setMcp('answer_question', () => mcpSoft('INVALID_OPTION', 'nope', { questionIndex: 1, invalid: ['Test'], offered: ['Unit', 'E2E'] }));
  const remote = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }, { choices: ['test'] }] });
  assert.deepEqual([remote.ok, remote.code, remote.question, remote.offered], [false, 'INVALID_OPTION', 2, ['Unit', 'E2E']]);
  assert.equal(called(host, 'answer_question').length, 1, 'no retry when the offered labels do not help');
  // A retry the host refuses again ends the loop: two calls, not three.
  host.mcpCalls.length = 0;
  host.setMcp('answer_question', () => mcpSoft('INVALID_OPTION', 'nope', { questionIndex: 1, invalid: ['x'], offered: ['Lint 2', 'Test 2'] }));
  const twice = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }, { choices: ['test'] }] });
  assert.deepEqual([twice.ok, twice.code, twice.question, twice.offered], [false, 'INVALID_OPTION', 2, ['Lint 2', 'Test 2']]);
  assert.equal(called(host, 'answer_question').length, 2);
});

test('too many answers or choices are refused locally; host refusals pass through with their code', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  const over = await callTool(app, 'answer_conductor_question', { answers: [{}, {}, {}] });
  assert.deepEqual([over.code, over.expected, over.got], ['ANSWER_COUNT_MISMATCH', 2, 3]);
  const many = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1', '2'] }] });
  assert.equal(many.code, 'TOO_MANY_CHOICES');
  assert.deepEqual(many.offered, ['Postgres (Recommended)', 'SQLite']);
  assert.equal(called(host, 'answer_question').length, 0);
  host.setMcp('answer_question', () => mcpSoft('SESSION_NOT_LIVE', 'session is retired'));
  const gone = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] });
  assert.deepEqual([gone.ok, gone.code, gone.message], [false, 'SESSION_NOT_LIVE', 'session is retired']);
  host.setMcp('answer_question', () => mcpThrown('kaboom'));
  assert.equal((await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1'] }] })).code, 'HOST_MCP_ERROR');
});

test('approve without confirmed:true makes no host call of any kind', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.requests.length = 0;
  for (const args of [{}, { confirmed: false }, { confirmed: null }, { feedback: 'yes do it' }]) {
    assert.equal((await callTool(app, 'approve_conductor_plan', args)).code, 'CONFIRMATION_REQUIRED', JSON.stringify(args));
  }
  assert.equal((await callTool(app, 'approve_conductor_plan', { confirmed: 'yes' })).code, 'INVALID_ARGS');
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(host.requests.length, 0, 'not even a REST read');
});

test('approve calls approve_plan after confirming a tool plan ask and a plan in the latest messages', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.setMcp('approve_plan', () => mcpOk({ sessionId: 's-a', mode: 'bypassPermissions', sentText: 'Approved.' }));
  const r = await callTool(app, 'approve_conductor_plan', { confirmed: true, feedback: 'go ahead' });
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments]), [
    ['get_recent_messages', { sessionId: 's-a' }],
    ['approve_plan', { sessionId: 's-a', feedback: 'go ahead' }],
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.sessionId, r.title, r.mode, r.delivered], ['cond-a', 'Alpha plan', 'bypassPermissions', true]);
  assert.match(r.note, /without permission prompts/);
  await callTool(app, 'approve_conductor_plan', { confirmed: true });
  assert.deepEqual(called(host, 'approve_plan')[1].arguments, { sessionId: 's-a' });
});

test('approve and reject need a tool plan ask on the row and a plan in the host latest messages', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  for (const name of ['approve_conductor_plan', 'reject_conductor_plan']) {
    const args = name.startsWith('approve') ? { confirmed: true } : {};
    // The row shows a question, not a plan: refused before any host call.
    host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool' });
    host.mcpCalls.length = 0;
    const wrongAsk = await callTool(app, name, args);
    assert.equal(wrongAsk.code, 'NO_PENDING_PLAN', name);
    assert.match(wrongAsk.message, /approval of a plan/);
    assert.equal(host.mcpCalls.length, 0);
    // Answered or auto-approved: the row shows nothing.
    host.setRow('cond-a', { awaitingUser: null, awaitingUserSource: null });
    assert.equal((await callTool(app, name, args)).code, 'NO_PENDING_PLAN', name);
    assert.equal(host.mcpCalls.length, 0);
    // The row says plan, but the host's fresh messages carry none.
    host.setRow('cond-a', { awaitingUser: 'plan', awaitingUserSource: 'tool' });
    host.addEvent('cond-a', { kind: 'turn_end' });
    host.addEvent('cond-a', { kind: 'assistant_message', msgId: `later-${name}`, message: { content: [{ type: 'text', text: 'no plan here' }] } });
    const noPlan = await callTool(app, name, args);
    assert.equal(noPlan.code, 'NO_PENDING_PLAN', name);
    assert.match(noPlan.message, /no plan in its latest messages/);
    assert.deepEqual(host.mcpCalls.map((c) => c.name), ['get_recent_messages'], 'verified, then stopped');
    host.addEvent('cond-a', { kind: 'turn_end' });
  }
  assert.equal(called(host, 'approve_plan').length + called(host, 'reject_plan').length, 0);
});

test('reject passes the feedback and keeps the mode the host reports', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.setMcp('reject_plan', (args) => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: args.feedback ?? '' }));
  const r = await callTool(app, 'reject_conductor_plan', { feedback: 'use a queue instead' });
  assert.deepEqual(called(host, 'reject_plan')[0].arguments, { sessionId: 's-a', feedback: 'use a queue instead' });
  assert.deepEqual([r.ok, r.mode, r.delivered, r.sessionId], [true, 'plan', true, 'cond-a']);
  await callTool(app, 'reject_conductor_plan', {});
  assert.deepEqual(called(host, 'reject_plan')[1].arguments, { sessionId: 's-a' });
  host.setMcp('reject_plan', () => mcpSoft('SESSION_NOT_LIVE', 'retired'));
  assert.equal((await callTool(app, 'reject_conductor_plan', {})).code, 'SESSION_NOT_LIVE');
});

test('the new tools validate their arguments', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  for (const [name, args] of [
    ['answer_conductor_question', {}],
    ['answer_conductor_question', { answers: 'first' }],
    ['answer_conductor_question', { answers: ['first'] }],
    ['answer_conductor_question', { answers: [[]] }],
    ['answer_conductor_question', { answers: [{ choices: 'first' }] }],
    ['answer_conductor_question', { answers: [{ choices: [{}] }] }],
    ['answer_conductor_question', { answers: [{ text: 3 }] }],
    ['answer_conductor_question', { answers: [{ note: [] }] }],
    ['reject_conductor_plan', { feedback: 3 }],
    ['approve_conductor_plan', { confirmed: true, feedback: {} }],
  ]) {
    assert.equal((await callTool(app, name, args)).code, 'INVALID_ARGS', `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(host.mcpCalls.length, 0);
});

test('worker sessions are never answered or decided: the tools act on the active conductor only', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.setRow('worker-1', { awaitingUser: 'plan', awaitingUserSource: 'tool' });
  for (const name of ['answer_conductor_question', 'approve_conductor_plan', 'reject_conductor_plan']) {
    const r = await callTool(app, name, { session: 'worker-1', confirmed: true, answers: [{ choices: ['1'] }] });
    assert.equal(r.ok, false, name);
  }
  assert.ok(host.mcpCalls.every((c) => c.arguments.sessionId !== 's-w'));
});

// ---- read_conductor_messages through the host's MCP ----

const say = (msgId, t) => ({ kind: 'assistant_message', msgId, message: { content: [{ type: 'text', text: t }] } });

test('read returns the latest message bonded to the turn plan or questions, with the ask markers', async (t) => {
  const { host, app } = await setup(t, {
    active: 'cond-a',
    events: {
      'cond-a': [
        say('old', 'from an earlier turn'), { kind: 'turn_end' },
        say('q', 'Two questions.'), { kind: 'user_question', questions: QUESTIONS },
        say('after', 'Waiting for your answers.'), { kind: 'turn_end' },
      ],
    },
  });
  const r = await callTool(app, 'read_conductor_messages');
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments]), [['get_recent_messages', { sessionId: 's-a' }]]);
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].questionCount, 2);
  assert.match(r.messages[0].text, /^Two questions\.\n--- questions ---\n1\. Which database\? \(multiSelect: false\) · header: DB\n   - Postgres \(Recommended\): robust\n   - SQLite: tiny\n2\./);
  assert.deepEqual(r.messages[1], { text: 'Waiting for your answers.' }, 'the trailing prose carries no ask markers');
  assert.doesNotMatch(r.messages[0].text, /message 1\/2/, 'the host boundary line is dropped');
});

test('read reports hasPlan and planPath for a plan turn', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.finishAsk('cond-a', { kind: 'plan', plan: 'Step 1', planPath: '/plans/p.md', prose: 'Plan below.', frames: false });
  const r = await callTool(app, 'read_conductor_messages');
  assert.deepEqual(r.messages, [{ text: 'Plan below.\n--- plan · saved to /plans/p.md ---\nStep 1', hasPlan: true, planPath: '/plans/p.md' }]);
});

test('an explicit count is passed through and returns exactly that many messages, unbonded', async (t) => {
  const { host, app } = await setup(t, {
    active: 'cond-a',
    events: { 'cond-a': [say('q', 'Question turn.'), { kind: 'user_question', questions: QUESTIONS }, say('after', 'Trailing prose.'), { kind: 'turn_end' }] },
  });
  const one = await callTool(app, 'read_conductor_messages', { count: 1 });
  assert.deepEqual(host.mcpCalls[0].arguments, { sessionId: 's-a', count: 1 });
  assert.deepEqual(one.messages, [{ text: 'Trailing prose.' }], 'count:1 is literal: the question message is not pulled in');
  const two = await callTool(app, 'read_conductor_messages', { count: 2 });
  assert.deepEqual(two.messages.map((m) => m.questionCount ?? null), [2, null]);
  assert.deepEqual(two.messages.map((m) => m.text.split('\n')[0]), ['Question turn.', 'Trailing prose.']);
});

test('a long read keeps the questions whole', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'word '.repeat(2000), frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages')).messages;
  assert.ok(m.text.length <= 4000);
  assert.ok(m.text.endsWith('   - Lint: style\n   - Test: unit'));
  assert.equal(m.questionCount, 2);
});

test('read falls back to the /events prose, logged, when the MCP read fails or the session has no id', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a', events: { 'cond-a': [say('a', 'one'), toolOnly, say('b', 'two')] } });
  const logged = t.mock.method(console, 'error', () => {});
  host.setMcp('get_recent_messages', () => mcpThrown('boom'));
  const down = await callTool(app, 'read_conductor_messages', { count: 2 });
  assert.deepEqual(down, { ok: true, sessionId: 'cond-a', title: 'Alpha plan', messages: [{ text: 'one' }, { text: 'two' }] });
  assert.ok(logged.mock.calls.some((c) => /get_recent_messages failed/.test(String(c.arguments[0]))));
  assert.deepEqual((await callTool(app, 'read_conductor_messages')).messages, [{ text: 'two' }], 'no count reads the last message');
  host.setMcp('get_recent_messages', undefined);
  host.setRow('cond-a', { sessionId: null });
  host.mcpCalls.length = 0;
  assert.deepEqual((await callTool(app, 'read_conductor_messages')).messages, [{ text: 'two' }]);
  assert.equal(host.mcpCalls.length, 0);
  assert.ok(logged.mock.calls.some((c) => /no host session id/.test(String(c.arguments[0]))));
});

// ---- review fixes ----

test('the host\'s 0-based NOT_MULTISELECT question index is reported 1-based', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  // The row shows a question but its event is out of reach, so choices pass through unchecked.
  host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool' });
  for (const index of [0, 2]) {
    host.setMcp('answer_question', () => mcpSoft('NOT_MULTISELECT', `Question ${index} is single-choice; use { option } not { options }.`, { questionIndex: index }));
    const r = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['1', '2'] }] });
    assert.deepEqual([r.ok, r.code, r.question], [false, 'NOT_MULTISELECT', index + 1]);
    assert.doesNotMatch(r.message, new RegExp(`Question ${index}\\b`), 'the host\'s 0-based wording is not repeated');
    assert.match(r.message, new RegExp(`Question ${index + 1} takes a single choice`));
  }
});

const BIG = Array.from({ length: 10 }, (_, q) => ({
  question: `Question ${q + 1}?`,
  header: `H${q + 1}`,
  multiSelect: false,
  options: Array.from({ length: 6 }, (_, o) => ({ label: `Q${q + 1}-Option-${o + 1}`, description: 'long description '.repeat(12) })),
}));

test('answering an oversized question set still uses the untruncated options; a read flags the cut', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.finishAsk('cond-a', { kind: 'question', questions: BIG, frames: false });
  host.mcpCalls.length = 0;
  const read = await callTool(app, 'read_conductor_messages');
  assert.equal(read.messages[0].questionCount, 10);
  assert.equal(read.messages[0].questionsTruncated, true);
  assert.ok(read.messages[0].text.length <= 4000);
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  const r = await callTool(app, 'answer_conductor_question', { answers: BIG.map((_, i) => ({ choices: [i === 9 ? '6' : '1'] })) });
  assert.equal(r.ok, true);
  const sent = called(host, 'answer_question')[0].arguments.answers;
  assert.deepEqual(sent[9], { option: 'Q10-Option-6' }, 'option 6 of question 10 resolves though the announced text had to shorten it');
  assert.equal(sent.length, 10);
});

test('a read of questions that fit carries no truncation flag', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages')).messages;
  assert.equal('questionsTruncated' in m, false);
});

test('a sub-agent question event is not the conductor\'s pending question', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, frames: false });
  // A later sub-agent question with other labels must not be the one answers map against.
  host.addEvent('cond-a', { kind: 'user_question', parentToolUseId: 'toolu_task', toolUseId: 'sub', questions: [{ question: 'Sub?', options: [{ label: 'Other' }] }] });
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  const r = await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['sqlite'] }, { choices: ['test'] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(called(host, 'answer_question')[0].arguments.answers, [{ option: 'SQLite' }, { options: ['Test'] }]);
});

test('a read of options that had to be dropped says so, and answering still reaches the dropped options by number', async (t) => {
  const { host, app } = await setup(t, { active: 'cond-a' });
  const many = [{ question: 'Which?', multiSelect: false, options: Array.from({ length: 400 }, (_, i) => ({ label: `Opt ${i}`, description: 'desc '.repeat(20) })) }];
  host.finishAsk('cond-a', { kind: 'question', questions: many, frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages')).messages;
  assert.equal(m.questionsTruncated, true);
  assert.equal(m.questionsDropped, true);
  assert.match(m.text, /more line\(s\) not shown$/);
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  assert.equal((await callTool(app, 'answer_conductor_question', { answers: [{ choices: ['400'] }] })).ok, true);
  assert.deepEqual(called(host, 'answer_question')[0].arguments.answers, [{ option: 'Opt 399' }]);
  // Shortened only: no dropped flag.
  const { host: host2, app: app2 } = await setup(t, { active: 'cond-a' });
  host2.finishAsk('cond-a', { kind: 'question', questions: BIG, frames: false });
  const [short] = (await callTool(app2, 'read_conductor_messages')).messages;
  assert.equal(short.questionsTruncated, true);
  assert.equal('questionsDropped' in short, false);
});
