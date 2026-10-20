// Pins: the tools hit exactly the intended host calls, name their conductor on
// every action, only ever touch conductor sessions (the worker guard), start
// announcing a conductor only when they act on it, and turn every failure into
// an {ok:false, code} result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { DECLARATIONS } from '../src/tools.js';
import { PART_CHARS, MAX_TEXT } from '../src/hostEvents.js';
import { startApp, callTool, req, CONDUCTOR_A, CONDUCTOR_B, WORKER } from './helpers.mjs';

async function setup(t, { instances = [CONDUCTOR_A, CONDUCTOR_B, WORKER], events } = {}) {
  const host = await startFakeHost({ instances, events });
  const app = await startApp({ host });
  t.after(async () => { await app.stop(); await host.close(); });
  host.requests.length = 0;
  return { host, app };
}

const text = (t) => ({ kind: 'assistant_message', message: { content: [{ type: 'text', text: t }] } });
const toolOnly = { kind: 'assistant_message', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } };

const CONDUCTOR_TOOLS = ['send_to_conductor', 'read_conductor_messages', 'answer_conductor_question', 'approve_conductor_plan', 'reject_conductor_plan'];

test('every tool that acts on a conductor declares session as a required string', () => {
  const byName = Object.fromEntries(DECLARATIONS.map((d) => [d.name, d.parameters]));
  for (const name of CONDUCTOR_TOOLS) {
    assert.ok(byName[name].required.includes('session'), `${name} requires session`);
    assert.equal(byName[name].properties.session.type, 'STRING', name);
  }
  for (const name of ['list_conductor_sessions', 'create_conductor_session']) assert.equal(byName[name].required, undefined, `${name} takes nothing`);
  for (const [name, params] of Object.entries(byName)) for (const key of params.required ?? []) assert.ok(key in params.properties, `${name}.${key} is declared`);
});

test('list returns conductors only with one host call', async (t) => {
  const { host, app } = await setup(t);
  const r = await callTool(app, 'list_conductor_sessions');
  assert.deepEqual(host.requests.map((q) => `${q.method} ${q.url}`), ['GET /api/instances']);
  assert.deepEqual(r, {
    ok: true,
    sessions: [
      { sessionId: 'cond-a', title: 'Alpha plan', status: 'idle', lastResponseAt: 1 },
      { sessionId: 'cond-b', title: 'Build the beta release pipeline and report back on everythi…', status: 'turn', lastResponseAt: 2 },
    ],
  });
  assert.equal(r.sessions[1].title.length, 60);
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
});

test('create ensures .conduct, spawns a conductor and starts announcing it', async (t) => {
  const { host, app } = await setup(t);
  const r = await callTool(app, 'create_conductor_session');
  assert.deepEqual(host.requests.map((q) => `${q.method} ${q.url}`), ['POST /api/projects/.conduct/ensure', 'POST /api/instances']);
  assert.deepEqual(host.requests[1].body, { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
  assert.equal(r.ok, true);
  assert.deepEqual(r, { ok: true, session: { sessionId: 'new-conductor-1', title: 'Untitled conductor', status: 'spawning', lastResponseAt: null } });
  assert.deepEqual(app.deps.state.get(), { watched: { 'new-conductor-1': { lastHandledTurnSeq: -1, lastHandledMsgId: null, lastHandledAskId: null } } });
});

test('send prompts the named conductor over /ws', async (t) => {
  const { host, app } = await setup(t);
  const r = await callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'run the tests' });
  assert.deepEqual(r, { ok: true, sessionId: 'cond-a', title: 'Alpha plan', delivered: true, note: 'The reply will be announced when the conductor finishes its turn.' });
  assert.equal(host.prompts.length, 1);
  assert.equal(host.prompts[0].id, 'cond-a');
  assert.equal(host.prompts[0].text, 'run the tests');
  assert.match(host.prompts[0].reqId, /^code-live-\d+$/);
});

test('send by id or case-insensitive title starts announcing that conductor once', async (t) => {
  const { host, app } = await setup(t, { events: { 'cond-b': [text('old'), { kind: 'turn_end' }] } });
  assert.deepEqual(app.deps.state.get().watched, {}, 'nothing is announced before the first action');
  await callTool(app, 'send_to_conductor', { text: 'hi', session: 'cond-b' });
  assert.deepEqual(Object.keys(app.deps.state.get().watched), ['cond-b']);
  assert.equal(host.prompts[0].id, 'cond-b');
  const cursor = app.deps.state.get().watched['cond-b'];
  assert.equal(cursor.lastHandledTurnSeq, 2, 'the turns it had finished are marked handled');
  // A second send to a watched conductor keeps its cursor, however it is named.
  host.finishTurn('cond-b', 'new', { notify: false });
  await callTool(app, 'send_to_conductor', { text: 'again', session: 'BUILD THE BETA RELEASE PIPELINE AND REPORT BACK ON EVERYTHI…' });
  assert.deepEqual(app.deps.state.get().watched['cond-b'], cursor);
  const byTitle = await callTool(app, 'send_to_conductor', { text: 'x', session: 'alpha PLAN' });
  assert.equal(byTitle.sessionId, 'cond-a');
  assert.deepEqual(Object.keys(app.deps.state.get().watched).sort(), ['cond-a', 'cond-b']);
});

// Invariant: a read lists the last N text messages with their keys from the events route alone, and never starts announcing.
test('read returns the last N text messages and never starts announcing', async (t) => {
  const { host, app } = await setup(t, {
    events: { 'cond-b': [text('one'), toolOnly, text('two'), { kind: 'turn_end' }, text('three'), toolOnly] },
  });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-b', count: 2 });
  assert.deepEqual(r, {
    ok: true,
    sessionId: 'cond-b',
    title: 'Build the beta release pipeline and report back on everythi…',
    messages: [{ messageKey: '3-m3', text: 'two', totalChars: 3 }, { messageKey: '5-m5', text: 'three', totalChars: 5 }],
    nextBefore: '3-m3',
  });
  assert.equal(host.mcpCalls.length, 0, 'reads use the events route only');
  assert.deepEqual(app.deps.state.get().watched, {});
  const one = await callTool(app, 'read_conductor_messages', { session: 'cond-b' });
  assert.deepEqual(one.messages, [{ messageKey: '5-m5', text: 'three', totalChars: 5 }]);
});

test('worker sessions are refused everywhere', async (t) => {
  const { host, app } = await setup(t);
  host.setRow('worker-1', { awaitingUser: 'plan', awaitingUserSource: 'tool' });
  for (const name of CONDUCTOR_TOOLS) {
    const r = await callTool(app, name, { session: 'worker-1', text: 'x', confirmed: true, answers: [{ choices: ['1'] }] });
    assert.deepEqual([r.ok, r.code], [false, 'NOT_A_CONDUCTOR'], name);
  }
  assert.equal(host.prompts.length, 0, 'no prompt reaches a worker');
  assert.ok(!host.requests.some((q) => q.url.includes('worker-1')));
  assert.equal(host.mcpCalls.length, 0, 'no MCP call reaches a worker');
  assert.deepEqual(app.deps.state.get().watched, {});
  // The worker shares a title with a conductor; titles match conductors only.
  const r = await callTool(app, 'send_to_conductor', { text: 'x', session: 'Alpha plan' });
  assert.equal(r.sessionId, 'cond-a');
});

test('session resolution errors', async (t) => {
  const dup = { ...CONDUCTOR_B, id: 'cond-c', title: 'Alpha plan' };
  const { host, app } = await setup(t, { instances: [CONDUCTOR_A, dup, WORKER] });
  host.requests.length = 0;
  for (const name of CONDUCTOR_TOOLS) {
    for (const session of [undefined, null, '', '   ']) {
      const r = await callTool(app, name, { text: 'x', confirmed: true, answers: [], ...(session === undefined ? {} : { session }) });
      assert.deepEqual([r.ok, r.code], [false, 'INVALID_ARGS'], `${name} ${JSON.stringify(session)}`);
      assert.match(r.message, /session is required/);
    }
    assert.equal((await callTool(app, name, { text: 'x', confirmed: true, answers: [], session: 5 })).message, 'session must be a string');
  }
  assert.equal(host.requests.length, 0, 'no host request for a missing session');
  for (const name of CONDUCTOR_TOOLS) {
    const args = { text: 'x', confirmed: true, answers: [{ choices: ['1'] }] };
    const unknown = await callTool(app, name, { ...args, session: 'nope' });
    assert.equal(unknown.code, 'UNKNOWN_SESSION', name);
    assert.match(unknown.message, /Alpha plan/);
    const amb = await callTool(app, name, { ...args, session: 'alpha plan' });
    assert.equal(amb.code, 'AMBIGUOUS_SESSION', name);
    assert.match(amb.message, /cond-a/);
    assert.match(amb.message, /cond-c/);
  }
  assert.equal(host.prompts.length, 0);
  assert.equal(host.mcpCalls.length, 0);
  assert.deepEqual(app.deps.state.get().watched, {});
});

test('argument validation and unknown tools', async (t) => {
  const { host, app } = await setup(t);
  for (const [name, args] of [
    ['send_to_conductor', { session: 'cond-a' }],
    ['send_to_conductor', { session: 'cond-a', text: '   ' }],
    ['send_to_conductor', { text: 'x', session: 5 }],
    ['read_conductor_messages', { session: 'cond-a', count: 0 }],
    ['read_conductor_messages', { session: 'cond-a', count: 11 }],
    ['read_conductor_messages', { session: 'cond-a', count: 1.5 }],
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
  const { host, app } = await setup(t);
  host.setAckMode('refuse');
  const refused = await callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'x' });
  assert.equal(refused.code, 'HOST_REFUSED');
  assert.match(refused.message, /not running/);
  host.setAckMode('silent');
  assert.equal((await callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'x' })).code, 'ACK_TIMEOUT');
});

test('an unreachable host is HOST_UNAVAILABLE', async (t) => {
  const { host, app } = await setup(t);
  await host.close();
  assert.equal((await callTool(app, 'list_conductor_sessions')).code, 'HOST_UNAVAILABLE');
  assert.equal((await callTool(app, 'send_to_conductor', { session: 'cond-a', text: 'x' })).code, 'HOST_UNAVAILABLE');
});

// ---- answering questions and deciding plans ----

import { mcpOk, mcpSoft, mcpThrown } from './fakes/fakeHost.mjs';

const QUESTIONS = [
  { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres (Recommended)', description: 'robust' }, { label: 'SQLite', description: 'tiny' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: 'style' }, { label: 'Test', description: 'unit' }] },
];
const called = (host, name) => host.mcpCalls.filter((c) => c.name === name);

// A conductor stopped on a question or plan, with no /ws frames so the
// announcer stays out of the MCP call log.
async function askSetup(t, kind, opts = {}) {
  const ctx = await setup(t);
  ctx.host.finishAsk('cond-a', { kind, questions: QUESTIONS, plan: 'The plan.', planPath: '/plans/p.md', frames: false, ...opts });
  ctx.host.mcpCalls.length = 0;
  return ctx;
}

test('answer maps spoken choices to exact labels and sends them under the row sessionId', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'bypassPermissions', sentText: 'answers' }));
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['sqlite'] }, { choices: ['1', 'test'], note: 'fast' }] });
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
  await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: [2] }, { text: 'all of them' }] });
  assert.deepEqual(called(host, 'answer_question')[1].arguments.answers, [{ option: 'SQLite' }, { text: 'all of them' }]);
  await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] });
  assert.deepEqual(called(host, 'answer_question')[2].arguments.answers, [{ option: 'Postgres (Recommended)' }, {}], 'missing trailing entries are skipped');
});

test('the MCP session id is read from the live row on every call; a row without one is SESSION_NOT_READY', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  host.setMcp('answer_question', () => mcpOk({ sessionId: 'x', mode: 'plan', sentText: 't' }));
  await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] });
  host.setRow('cond-a', { sessionId: 's-a-renewed' });
  await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] });
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments.sessionId), ['s-a', 's-a-renewed']);
  host.setRow('cond-a', { sessionId: null });
  host.mcpCalls.length = 0;
  for (const [name, args] of [['answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] }], ['reject_conductor_plan', { session: 'cond-a' }], ['approve_conductor_plan', { session: 'cond-a', confirmed: true }]]) {
    assert.equal((await callTool(app, name, args)).code, 'SESSION_NOT_READY', name);
  }
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(JSON.stringify(app.deps.state.get()).includes('s-a'), false, 'the host session id is never persisted');
});

test('answer is refused without a pending tool question, before any host call', async (t) => {
  const { host, app } = await setup(t);
  assert.equal((await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] })).code, 'NO_PENDING_QUESTION');
  for (const row of [{ awaitingUser: 'plan', awaitingUserSource: 'tool' }, { awaitingUser: 'question', awaitingUserSource: 'text' }, { awaitingUser: null, awaitingUserSource: null }]) {
    host.setRow('cond-a', row);
    assert.equal((await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] })).code, 'NO_PENDING_QUESTION', JSON.stringify(row));
  }
  assert.equal(host.mcpCalls.length, 0, 'the host would have answered the stale question');
});

test('a host INVALID_OPTION is retried exactly once against the labels the host offers', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  let n = 0;
  host.setMcp('answer_question', (args) => (++n === 1
    ? mcpSoft('INVALID_OPTION', 'not offered', { questionIndex: 0, invalid: ['Sqlite'], offered: ['Postgres 16', 'SQLite 3'] })
    : mcpOk({ sessionId: 's-a', mode: 'plan', sentText: JSON.stringify(args.answers) })));
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['sqlite'] }, { choices: ['Lint'] }] });
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
  const local = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['mongo'] }] });
  assert.deepEqual([local.ok, local.code, local.question, local.offered], [false, 'INVALID_OPTION', 1, ['Postgres (Recommended)', 'SQLite']]);
  assert.equal(called(host, 'answer_question').length, 0);
  // The host's labels differ and the words match none of them: one retry is not even possible.
  host.setMcp('answer_question', () => mcpSoft('INVALID_OPTION', 'nope', { questionIndex: 1, invalid: ['Test'], offered: ['Unit', 'E2E'] }));
  const remote = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }, { choices: ['test'] }] });
  assert.deepEqual([remote.ok, remote.code, remote.question, remote.offered], [false, 'INVALID_OPTION', 2, ['Unit', 'E2E']]);
  assert.equal(called(host, 'answer_question').length, 1, 'no retry when the offered labels do not help');
  // A retry the host refuses again ends the loop: two calls, not three.
  host.mcpCalls.length = 0;
  host.setMcp('answer_question', () => mcpSoft('INVALID_OPTION', 'nope', { questionIndex: 1, invalid: ['x'], offered: ['Lint 2', 'Test 2'] }));
  const twice = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }, { choices: ['test'] }] });
  assert.deepEqual([twice.ok, twice.code, twice.question, twice.offered], [false, 'INVALID_OPTION', 2, ['Lint 2', 'Test 2']]);
  assert.equal(called(host, 'answer_question').length, 2);
});

test('too many answers or choices are refused locally; host refusals pass through with their code', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  const over = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{}, {}, {}] });
  assert.deepEqual([over.code, over.expected, over.got], ['ANSWER_COUNT_MISMATCH', 2, 3]);
  const many = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1', '2'] }] });
  assert.equal(many.code, 'TOO_MANY_CHOICES');
  assert.deepEqual(many.offered, ['Postgres (Recommended)', 'SQLite']);
  assert.equal(called(host, 'answer_question').length, 0);
  host.setMcp('answer_question', () => mcpSoft('SESSION_NOT_LIVE', 'session is retired'));
  const gone = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] });
  assert.deepEqual([gone.ok, gone.code, gone.message], [false, 'SESSION_NOT_LIVE', 'session is retired']);
  host.setMcp('answer_question', () => mcpThrown('kaboom'));
  assert.equal((await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1'] }] })).code, 'HOST_MCP_ERROR');
});

test('approve without confirmed:true makes no host call of any kind', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.requests.length = 0;
  for (const args of [{ session: 'cond-a' }, { session: 'cond-a', confirmed: false }, { session: 'cond-a', confirmed: null }, { session: 'cond-a', feedback: 'yes do it' }]) {
    assert.equal((await callTool(app, 'approve_conductor_plan', args)).code, 'CONFIRMATION_REQUIRED', JSON.stringify(args));
  }
  assert.equal((await callTool(app, 'approve_conductor_plan', { session: 'cond-a', confirmed: 'yes' })).code, 'INVALID_ARGS');
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(host.requests.length, 0, 'not even a REST read');
});

// Invariant: approve confirms the row's tool plan ask and a plan_request with its ended turn from the events route,
// then makes exactly one /mcp call, the write.
test('approve calls approve_plan after confirming a tool plan ask and its plan event', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.setMcp('approve_plan', () => mcpOk({ sessionId: 's-a', mode: 'bypassPermissions', sentText: 'Approved.' }));
  const r = await callTool(app, 'approve_conductor_plan', { session: 'cond-a', confirmed: true, feedback: 'go ahead' });
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments]), [['approve_plan', { sessionId: 's-a', feedback: 'go ahead' }]]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.sessionId, r.title, r.mode, r.delivered], ['cond-a', 'Alpha plan', 'bypassPermissions', true]);
  assert.match(r.note, /without permission prompts/);
  await callTool(app, 'approve_conductor_plan', { session: 'cond-a', confirmed: true });
  assert.deepEqual(called(host, 'approve_plan')[1].arguments, { sessionId: 's-a' });
});

// Invariant: approve and reject need the row's tool plan ask and a plan_request whose turn ended; each refusal comes
// before any /mcp call.
test('approve and reject need a tool plan ask on the row and a plan event with its turn end', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  for (const name of ['approve_conductor_plan', 'reject_conductor_plan']) {
    const args = name.startsWith('approve') ? { session: 'cond-a', confirmed: true } : { session: 'cond-a' };
    // The row shows a question, not a plan.
    host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool' });
    const wrongAsk = await callTool(app, name, args);
    assert.equal(wrongAsk.code, 'NO_PENDING_PLAN', name);
    assert.match(wrongAsk.message, /approval of a plan/);
    // Answered or auto-approved: the row shows nothing.
    host.setRow('cond-a', { awaitingUser: null, awaitingUserSource: null });
    assert.equal((await callTool(app, name, args)).code, 'NO_PENDING_PLAN', name);
    // The row says plan, but the events hold no plan_request.
    host.setRow('cond-a', { awaitingUser: 'plan', awaitingUserSource: 'tool' });
    host.resetRing('cond-a', { drop: (ev) => ev.kind === 'plan_request' });
    const noPlan = await callTool(app, name, args);
    assert.equal(noPlan.code, 'NO_PENDING_PLAN', name);
    assert.match(noPlan.message, /no plan in its latest events/);
    // A plan_request whose turn has not ended is not yet decidable.
    host.addEvent('cond-a', { kind: 'plan_request', toolUseId: `open-${name}`, plan: 'Still being written' });
    assert.equal((await callTool(app, name, args)).code, 'NO_PENDING_PLAN', name);
    host.resetRing('cond-a', { drop: (ev) => ev.kind === 'plan_request' });
    assert.equal(host.mcpCalls.length, 0, 'every refusal came before any /mcp call');
  }
});

test('reject passes the feedback and keeps the mode the host reports', async (t) => {
  const { host, app } = await askSetup(t, 'plan');
  host.setMcp('reject_plan', (args) => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: args.feedback ?? '' }));
  const r = await callTool(app, 'reject_conductor_plan', { session: 'cond-a', feedback: 'use a queue instead' });
  assert.deepEqual(called(host, 'reject_plan')[0].arguments, { sessionId: 's-a', feedback: 'use a queue instead' });
  assert.deepEqual([r.ok, r.mode, r.delivered, r.sessionId], [true, 'plan', true, 'cond-a']);
  await callTool(app, 'reject_conductor_plan', { session: 'cond-a' });
  assert.deepEqual(called(host, 'reject_plan')[1].arguments, { sessionId: 's-a' });
  host.setMcp('reject_plan', () => mcpSoft('SESSION_NOT_LIVE', 'retired'));
  assert.equal((await callTool(app, 'reject_conductor_plan', { session: 'cond-a' })).code, 'SESSION_NOT_LIVE');
});

test('the new tools validate their arguments', async (t) => {
  const { host, app } = await askSetup(t, 'question');
  for (const [name, args] of [
    ['answer_conductor_question', { session: 'cond-a' }],
    ['answer_conductor_question', { session: 'cond-a', answers: 'first' }],
    ['answer_conductor_question', { session: 'cond-a', answers: ['first'] }],
    ['answer_conductor_question', { session: 'cond-a', answers: [[]] }],
    ['answer_conductor_question', { session: 'cond-a', answers: [{ choices: 'first' }] }],
    ['answer_conductor_question', { session: 'cond-a', answers: [{ choices: [{}] }] }],
    ['answer_conductor_question', { session: 'cond-a', answers: [{ text: 3 }] }],
    ['answer_conductor_question', { session: 'cond-a', answers: [{ note: [] }] }],
    ['reject_conductor_plan', { session: 'cond-a', feedback: 3 }],
    ['approve_conductor_plan', { session: 'cond-a', confirmed: true, feedback: {} }],
  ]) {
    assert.equal((await callTool(app, name, args)).code, 'INVALID_ARGS', `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(host.mcpCalls.length, 0);
});

test('worker sessions are never answered or decided, even when the worker shows a pending ask', async (t) => {
  const { host, app } = await setup(t);
  host.setRow('worker-1', { awaitingUser: 'plan', awaitingUserSource: 'tool' });
  for (const name of ['answer_conductor_question', 'approve_conductor_plan', 'reject_conductor_plan']) {
    const r = await callTool(app, name, { session: 'worker-1', confirmed: true, answers: [{ choices: ['1'] }] });
    assert.deepEqual([r.ok, r.code], [false, 'NOT_A_CONDUCTOR'], name);
  }
  assert.equal(host.mcpCalls.length, 0);
});

test('answering one conductor never touches another that is also waiting', async (t) => {
  const { host, app } = await setup(t);
  const cloud = [{ question: 'Which cloud?', header: 'Cloud', multiSelect: false, options: [{ label: 'AWS', description: 'a' }, { label: 'GCP', description: 'g' }] }];
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, frames: false });
  host.finishAsk('cond-b', { kind: 'question', questions: cloud, frames: false });
  host.mcpCalls.length = 0;
  host.setMcp('answer_question', (args) => mcpOk({ sessionId: args.sessionId, mode: 'plan', sentText: 't' }));
  const b = await callTool(app, 'answer_conductor_question', { session: 'cond-b', answers: [{ choices: ['gcp'] }] });
  assert.equal(b.sessionId, 'cond-b');
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments), [{ sessionId: 's-b', answers: [{ option: 'GCP' }] }], 'mapped against B\'s labels, sent for B only');
  assert.equal(host.state.instances.find((i) => i.id === 'cond-a').awaitingUser, 'question', 'A still waits');
  const a = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['sqlite'] }, { choices: ['lint'] }] });
  assert.equal(a.ok, true);
  assert.deepEqual(called(host, 'answer_question').map((c) => c.arguments.sessionId), ['s-b', 's-a']);
});

test('approving or rejecting one conductor never touches another that is also waiting on a plan', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: 'Plan A', planPath: '/plans/a.md', frames: false });
  host.finishAsk('cond-b', { kind: 'plan', plan: 'Plan B', planPath: '/plans/b.md', frames: false });
  host.mcpCalls.length = 0;
  host.setMcp('approve_plan', (args) => mcpOk({ sessionId: args.sessionId, mode: 'bypassPermissions', sentText: 'ok' }));
  host.setMcp('reject_plan', (args) => mcpOk({ sessionId: args.sessionId, mode: 'plan', sentText: 'no' }));
  assert.equal((await callTool(app, 'approve_conductor_plan', { session: 'cond-a', confirmed: true })).sessionId, 'cond-a');
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments.sessionId]), [['approve_plan', 's-a']]);
  host.mcpCalls.length = 0;
  assert.equal((await callTool(app, 'reject_conductor_plan', { session: 'cond-b', feedback: 'smaller' })).sessionId, 'cond-b');
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments.sessionId]), [['reject_plan', 's-b']]);
});

test('a named conductor with no pending ask is refused while another conductor waits', async (t) => {
  const { host, app } = await setup(t);
  const title = 'Build the beta release pipeline and report back on everythi…';
  const refusals = [
    ['answer_conductor_question', { answers: [{ choices: ['1'] }] }, 'NO_PENDING_QUESTION'],
    ['approve_conductor_plan', { confirmed: true }, 'NO_PENDING_PLAN'],
    ['reject_conductor_plan', {}, 'NO_PENDING_PLAN'],
  ];
  // A awaits a question, then a plan; B has neither.
  for (const ask of [{ kind: 'question', questions: QUESTIONS }, { kind: 'plan', plan: 'Plan A' }]) {
    host.finishAsk('cond-a', { ...ask, frames: false });
    host.mcpCalls.length = 0;
    for (const [name, args, code] of refusals) {
      const r = await callTool(app, name, { session: 'cond-b', ...args });
      assert.deepEqual([r.ok, r.code], [false, code], `${ask.kind} ${name}`);
      assert.ok(r.message.startsWith(`"${title}"`), r.message);
    }
    assert.equal(host.mcpCalls.length, 0);
  }
});

// ---- read_conductor_messages over the events route ----

const say = (msgId, t) => ({ kind: 'assistant_message', msgId, message: { content: [{ type: 'text', text: t }] } });

const BIG_PLAN = Array.from({ length: 1500 }, (_, i) => `${i + 1}. step number ${i + 1} of the plan`).join('\n') + '\nLAST-LINE-UNIQUE';

// Every part of one message, read through its key: the part results, in order.
async function readParts(app, messageKey, session = 'cond-a') {
  const first = await callTool(app, 'read_conductor_messages', { session, messageKey });
  assert.equal(first.ok, true, JSON.stringify(first));
  const results = [first];
  for (let part = 2; part <= first.parts; part++) results.push(await callTool(app, 'read_conductor_messages', { session, messageKey, part }));
  return results;
}

// Invariant: the latest message and the plan or questions its turn ended on come back bonded, each with its key and
// ask markers, and the trailing prose carries no markers.
test('read returns the latest message bonded to the turn plan or questions, with the ask markers', async (t) => {
  const { host, app } = await setup(t, {
    events: {
      'cond-a': [
        say('old', 'from an earlier turn'), { kind: 'turn_end' },
        say('q', 'Two questions.'), { kind: 'user_question', questions: QUESTIONS },
        say('after', 'Waiting for your answers.'), { kind: 'turn_end' },
      ],
    },
  });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 2);
  assert.deepEqual([r.messages[0].messageKey, r.messages[0].questionCount], ['3-q', 2]);
  assert.match(r.messages[0].text, /^Two questions\.\n--- questions ---\n1\. Which database\? \(multiSelect: false\) · header: DB\n   - Postgres \(Recommended\): robust\n   - SQLite: tiny\n2\./);
  assert.deepEqual(r.messages[1], { messageKey: '5-after', text: 'Waiting for your answers.', totalChars: 25 }, 'the trailing prose carries no ask markers');
});

// Invariant: a plan turn lists hasPlan and planPath, and the body carries the host's plan fence.
test('read reports hasPlan and planPath for a plan turn', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: 'Step 1', planPath: '/plans/p.md', prose: 'Plan below.', frames: false });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  const text = 'Plan below.\n--- plan · saved to /plans/p.md ---\nStep 1';
  assert.deepEqual(r.messages, [{ messageKey: '1-m1', text, totalChars: text.length, hasPlan: true, planPath: '/plans/p.md' }]);
});

// Invariant: a reply over PART_CHARS lists cut (truncated, totalChars, text within MAX_TEXT, a hint) and pages back,
// from part 1 to parts, to exactly its body, each part within PART_CHARS, with no /mcp call.
test('long prose lists truncated and reads back whole by its messageKey', async (t) => {
  const { host, app } = await setup(t);
  const prose = Array.from({ length: Math.ceil(PART_CHARS * 2.5 / 20) }, (_, i) => `line ${i} of the reply`).join('\n');
  host.finishTurn('cond-a', prose, { notify: false });
  const listing = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  const [m] = listing.messages;
  assert.equal(m.truncated, true);
  assert.equal(m.totalChars, prose.length);
  assert.ok(m.text.length <= MAX_TEXT);
  assert.match(listing.hint, /read each whole with its messageKey/);
  const results = await readParts(app, m.messageKey);
  assert.equal(results.length, 3);
  assert.equal(results.map((r) => r.text).join(''), prose);
  results.forEach((r, i) => {
    assert.ok(r.text.length <= PART_CHARS);
    assert.deepEqual([r.part, r.parts, r.totalChars, r.messageKey], [i + 1, 3, prose.length, m.messageKey]);
  });
  assert.equal(host.mcpCalls.length, 0);
  assert.deepEqual(app.deps.state.get().watched, {}, 'reading never starts announcing');
});

// Invariant: a plan over MAX_TEXT reads back whole whether the plan sits in the ExitPlanMode input or only on the
// plan_request (the file-backed case), with its plan file named.
test('a long plan reads back whole, with the plan in the tool input or only on the plan_request', async (t) => {
  for (const inputPlan of [true, false]) {
    const { host, app } = await setup(t);
    host.finishAsk('cond-a', { kind: 'plan', plan: BIG_PLAN, planPath: '/plans/p.md', prose: 'The plan.', inputPlan, frames: false });
    const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
    assert.deepEqual([m.hasPlan, m.planPath, m.truncated], [true, '/plans/p.md', true]);
    const results = await readParts(app, m.messageKey);
    assert.equal(results.map((r) => r.text).join(''), `The plan.\n--- plan · saved to /plans/p.md ---\n${BIG_PLAN}`, `inputPlan ${inputPlan}`);
    assert.equal(results[0].hasPlan, true);
  }
});

// Invariant: a plan_request carrying autoApproved:true is a plan like any other and reads back whole.
test('an auto-approved plan reads back whole', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'plan', plan: BIG_PLAN, autoApproved: true, frames: false, row: { awaitingUser: null, awaitingUserSource: null } });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.equal((await readParts(app, m.messageKey)).map((r) => r.text).join(''), `Before I continue:\n--- plan ---\n${BIG_PLAN}`);
});

// Invariant: the hard-cut path (no newline in reach) still loses nothing.
test('a body with no newlines reads back whole', async (t) => {
  const { host, app } = await setup(t);
  const prose = 'x'.repeat(PART_CHARS * 2 + 5);
  host.finishTurn('cond-a', prose, { notify: false });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  const results = await readParts(app, m.messageKey);
  assert.equal(results.length, 3);
  assert.equal(results.map((r) => r.text).join(''), prose);
});

// Invariant: a message within MAX_TEXT, and questions that fit, list without truncated and without a hint.
test('a short message and fitting questions list without truncation flags', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'Short.', frames: false });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.equal('truncated' in r.messages[0], false);
  assert.equal('hint' in r, false);
});

// Invariant: a sub-agent's message never lists, and its key reads as MESSAGE_NOT_FOUND, not its text.
test('a sub-agent message is excluded from listings and from key reads', async (t) => {
  const { host, app } = await setup(t, {
    events: { 'cond-a': [say('main', 'the conductor speaking'), { ...say('sub', 'x'.repeat(9000)), parentToolUseId: 'toolu_task' }, { kind: 'turn_end' }] },
  });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a', count: 5 });
  assert.deepEqual(r.messages.map((m) => m.text), ['the conductor speaking']);
  const key = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: '2-sub' });
  assert.deepEqual([key.ok, key.code], [false, 'MESSAGE_NOT_FOUND']);
  assert.equal(host.mcpCalls.length, 0);
});

// Invariant: a message older than the in-memory ring (served from disk as deltas only, past the first events page) is
// reachable by paging back with nextBefore and reads whole by its key.
test('a message older than the ring is reached with nextBefore and read whole', async (t) => {
  const { host, app } = await setup(t);
  const old = Array.from({ length: 900 }, (_, i) => `archived line ${i}`).join('\n');
  host.finishTurn('cond-a', old, { notify: false });
  for (let i = 0; i < 600; i++) host.addEvent('cond-a', { kind: 'tool_use', name: 'Bash' });
  host.finishTurn('cond-a', 'the newest message', { notify: false });
  host.archiveBelow('cond-a', 300);
  const latest = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.deepEqual(latest.messages.map((m) => m.text), ['the newest message']);
  assert.ok(latest.nextBefore, 'older messages exist');
  const older = await callTool(app, 'read_conductor_messages', { session: 'cond-a', before: latest.nextBefore });
  assert.equal(older.messages.length, 1);
  assert.equal(older.messages[0].truncated, true);
  assert.equal(older.messages[0].totalChars, old.length);
  assert.equal(older.nextBefore, undefined, 'nothing is older');
  assert.equal((await readParts(app, older.messages[0].messageKey)).map((r) => r.text).join(''), old);
});

// Adds `n` top-level events that belong to no message (tool traffic) to a conductor.
const noise = (host, n, id = 'cond-a') => { for (let i = 0; i < n; i++) host.addEvent(id, { kind: 'tool_use', name: 'Bash', input: {} }); };
// Adds a message streamed as one message_start and `deltas` text_deltas of `chunk`.
function streamLong(host, msgId, deltas, chunk = 'word ', id = 'cond-a') {
  host.addEvent(id, { kind: 'message_start', msgId });
  for (let i = 0; i < deltas; i++) host.addEvent(id, { kind: 'text_delta', msgId, blockIdx: 0, text: chunk });
}

// Invariant: a window that ends inside a plan message never drops that message: the plan bonded to the trailing prose
// of its turn is listed with it, though the host has older events than the newest page.
test('a plan message at the old end of the newest page is listed, bonded to the trailing prose', async (t) => {
  const { host, app } = await setup(t);
  noise(host, 99);
  host.addEvent('cond-a', { kind: 'turn_end' });
  host.addEvent('cond-a', { kind: 'message_start', msgId: 'plan-msg' });
  host.addEvent('cond-a', { kind: 'text_delta', msgId: 'plan-msg', blockIdx: 0, text: 'The plan.' });
  host.addEvent('cond-a', { kind: 'tool_use', msgId: 'plan-msg', blockIdx: 1, toolUseId: 'tuP', name: 'ExitPlanMode', input: { plan: 'Step 1' } });
  host.addEvent('cond-a', { kind: 'plan_request', toolUseId: 'tuP', plan: 'Step 1', planPath: null });
  host.addEvent('cond-a', { kind: 'message_start', msgId: 'prose-msg' });
  host.addEvent('cond-a', { kind: 'text_delta', msgId: 'prose-msg', blockIdx: 0, text: 'Waiting for approval.' });
  noise(host, 441);
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.deepEqual(r.messages.map((m) => [m.messageKey, m.hasPlan ?? false]), [['101-plan-msg', true], ['105-prose-msg', false]]);
  assert.equal(r.messages[0].text, 'The plan.\n--- plan ---\nStep 1');
});

// Invariant: a message longer than several event pages is listed whole (its start found by reading back), never
// dropped as a fragment and never an empty success; its key then reads it whole.
test('one message of thousands of events lists and reads back whole', async (t) => {
  const { host, app } = await setup(t);
  streamLong(host, 'long', 4500);
  host.addEvent('cond-a', { kind: 'turn_end' });
  const body = 'word '.repeat(4500);
  for (const args of [{}, { count: 1 }]) {
    const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a', ...args });
    assert.equal(r.ok, true, JSON.stringify(args));
    assert.deepEqual(r.messages.map((m) => [m.messageKey, m.totalChars, m.truncated]), [['1-long', body.length, true]], JSON.stringify(args));
    assert.match(r.hint, /read each whole/);
  }
  assert.equal((await readParts(app, '1-long')).map((p) => p.text).join(''), body);
});

// Invariant: when no whole message lies within the reach of a read, a listing is refused, never an empty success; a
// keyed read of a message that does not close within its page bound is refused, never returned as a fragment.
test('a message beyond the read bound is refused by both reads', async (t) => {
  const { host, app } = await setup(t);
  streamLong(host, 'huge', 33_000, 'x');
  host.addEvent('cond-a', { kind: 'turn_end' });
  const listing = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.deepEqual([listing.ok, listing.code], [false, 'MESSAGES_NOT_REACHED']);
  const keyed = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: '1-huge' });
  assert.deepEqual([keyed.ok, keyed.code], [false, 'MESSAGE_TOO_LONG']);
});

// Invariant: a message still being written reads as what has arrived, and says so; once its turn ends it does not.
test('a message still being written is read with inProgress until it closes', async (t) => {
  const { host, app } = await setup(t);
  streamLong(host, 'live', 3, 'abc ');
  const open = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: '1-live' });
  assert.deepEqual([open.ok, open.inProgress, open.text], [true, true, 'abc abc abc ']);
  host.addEvent('cond-a', { kind: 'turn_end' });
  const closed = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: '1-live' });
  assert.equal('inProgress' in closed, false);
});

// Invariant: a key whose seq a respawn has moved into the middle of the same message (same msgId, so the msgId check
// passes) is MESSAGE_NOT_FOUND, never the tail of that message.
test('a key that lands inside its own renumbered message is MESSAGE_NOT_FOUND, not the tail', async (t) => {
  const { host, app } = await setup(t);
  noise(host, 2);
  for (const chunk of ['Hello ', 'beautiful ', 'world']) host.addEvent('cond-a', { kind: 'text_delta', msgId: 'X', blockIdx: 0, text: chunk });
  host.addEvent('cond-a', { kind: 'turn_end' });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.deepEqual([m.messageKey, m.text], ['3-X', 'Hello beautiful world']);
  host.resetRing('cond-a', { drop: (ev) => ev.msgId === undefined && ev.kind === 'tool_use' });
  const stale = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: m.messageKey });
  assert.deepEqual([stale.ok, stale.code], [false, 'MESSAGE_NOT_FOUND']);
  const fresh = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: '1-X' });
  assert.equal(fresh.text, 'Hello beautiful world');
});

// Invariant: when the newest page begins on a block opener of a message (not its first event), the listing does not
// present that message's tail as the whole: it reads back to the message's start, and the keyed read returns the same
// whole body.
test('a page that begins on a block opener of a message lists and reads that message whole', async (t) => {
  const { host, app } = await setup(t);
  host.addEvent('cond-a', { kind: 'turn_end' });
  const start = host.addEvent('cond-a', { kind: 'message_start', msgId: 'm' });
  host.addEvent('cond-a', { kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'FIRST ' });
  host.addEvent('cond-a', { kind: 'text_end', msgId: 'm', blockIdx: 0 });
  const seam = host.addEvent('cond-a', { kind: 'thinking_start', msgId: 'm', blockIdx: 1 });
  host.addEvent('cond-a', { kind: 'thinking_delta', msgId: 'm', blockIdx: 1, text: 'Narrating.', narration: true });
  host.addEvent('cond-a', { kind: 'text_delta', msgId: 'm', blockIdx: 2, text: 'SECOND ' });
  host.addEvent('cond-a', { kind: 'tool_use', msgId: 'm', blockIdx: 3, toolUseId: 'tuP', name: 'ExitPlanMode', input: { plan: 'Step 1' } });
  host.addEvent('cond-a', { kind: 'plan_request', toolUseId: 'tuP', plan: 'Step 1', planPath: null });
  host.addEvent('cond-a', { kind: 'message_start', msgId: 'tail' });
  const last = host.addEvent('cond-a', { kind: 'text_delta', msgId: 'tail', blockIdx: 0, text: 'Waiting for approval.' });
  noise(host, seam._seq + 499 - last._seq);
  assert.equal(host.state.events['cond-a'].at(-500)._seq, seam._seq, 'the newest page begins on the thinking_start');
  const body = 'FIRST SECOND \n--- narration ---\nNarrating.\n--- plan ---\nStep 1';
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.deepEqual(r.messages.map((m) => [m.messageKey, m.text]), [[`${start._seq}-m`, body], [`${last._seq - 1}-tail`, 'Waiting for approval.']]);
  const read = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: `${start._seq}-m` });
  assert.deepEqual([read.ok, read.text, read.totalChars], [true, body, body.length]);
  // A key pointing at the first delta after the seam is a fragment, not the message.
  const forged = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: `${seam._seq + 2}-m` });
  assert.deepEqual([forged.ok, forged.code], [false, 'MESSAGE_NOT_FOUND']);
});

// Invariant: a key never yields another message's text: an unknown key, and a key whose seq a respawn reassigned to a
// different message, are both MESSAGE_NOT_FOUND.
test('an unknown key and a renumbered key are MESSAGE_NOT_FOUND', async (t) => {
  const { host, app } = await setup(t);
  host.finishTurn('cond-a', 'first', { notify: false });
  host.finishTurn('cond-a', 'second', { notify: false });
  host.finishTurn('cond-a', 'third', { notify: false });
  const listed = await callTool(app, 'read_conductor_messages', { session: 'cond-a', count: 3 });
  const keys = listed.messages.map((m) => m.messageKey);
  assert.deepEqual(keys, ['1-m1', '6-m6', '11-m11']);
  for (const key of ['99-nothing', '6-m1']) {
    const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: key });
    assert.deepEqual([r.ok, r.code], [false, 'MESSAGE_NOT_FOUND'], key);
    assert.match(r.message, /list the messages again/);
  }
  // The first message is dropped and the rest renumbered: seq 6 now starts the third message.
  host.resetRing('cond-a', { drop: (ev) => ev.msgId === 'm1' || ev._seq <= 5 });
  const stale = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: keys[1] });
  assert.deepEqual([stale.ok, stale.code], [false, 'MESSAGE_NOT_FOUND']);
});

// Invariant: a part past the end is NO_SUCH_PART with expected/got; bad argument combinations are INVALID_ARGS before
// any host request.
test('read refuses a part past the end and bad argument combinations', async (t) => {
  const { host, app } = await setup(t);
  host.finishTurn('cond-a', 'short reply', { notify: false });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  const past = await callTool(app, 'read_conductor_messages', { session: 'cond-a', messageKey: m.messageKey, part: 2 });
  assert.deepEqual([past.code, past.expected, past.got], ['NO_SUCH_PART', 1, 2]);
  host.requests.length = 0;
  const key = m.messageKey;
  for (const args of [
    { part: 1 },
    { messageKey: key, count: 2 },
    { messageKey: key, before: key },
    { messageKey: 'nonsense' },
    { messageKey: '-m1' },
    { messageKey: '1-' },
    { messageKey: key, part: 0 },
    { messageKey: key, part: 1.5 },
    { messageKey: key, part: '2' },
    { before: 'x' },
    { messageKey: 7 },
  ]) {
    const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a', ...args });
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_ARGS'], JSON.stringify(args));
  }
  assert.equal(host.requests.length, 0);
});

// Invariant: an explicit count is literal (no bonding) and `before` lists the messages before a key, each over the
// events route.
test('count is literal and before pages to older messages', async (t) => {
  const { host, app } = await setup(t, {
    events: { 'cond-a': [say('q', 'Question turn.'), { kind: 'user_question', questions: QUESTIONS }, say('after', 'Trailing prose.'), { kind: 'turn_end' }] },
  });
  const one = await callTool(app, 'read_conductor_messages', { session: 'cond-a', count: 1 });
  assert.deepEqual(one.messages.map((m) => m.text), ['Trailing prose.'], 'count:1 is literal: the question message is not pulled in');
  const two = await callTool(app, 'read_conductor_messages', { session: 'cond-a', count: 2 });
  assert.deepEqual(two.messages.map((m) => m.questionCount ?? null), [2, null]);
  assert.deepEqual(two.messages.map((m) => m.text.split('\n')[0]), ['Question turn.', 'Trailing prose.']);
  const before = await callTool(app, 'read_conductor_messages', { session: 'cond-a', before: one.nextBefore });
  assert.deepEqual(before.messages.map((m) => m.messageKey), ['1-q']);
  assert.equal(host.mcpCalls.length, 0);
});

// Invariant: a long questions section stays whole at the end of a cut listing.
test('a long read keeps the questions whole', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, prose: 'word '.repeat(2000), frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.ok(m.text.length <= 4000);
  assert.ok(m.text.endsWith('   - Lint: style\n   - Test: unit'));
  assert.equal(m.questionCount, 2);
});

// Invariant: a read needs only the events route: a conductor with no host session id is read, and no /mcp call is made.
test('read works without a host session id and makes no /mcp call', async (t) => {
  const { host, app } = await setup(t, { events: { 'cond-a': [say('a', 'one'), toolOnly, say('b', 'two')] } });
  host.setRow('cond-a', { sessionId: null });
  const r = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.deepEqual(r.messages.map((m) => m.text), ['two']);
  assert.equal(host.mcpCalls.length, 0);
});

// ---- review fixes ----

test('the host\'s 0-based NOT_MULTISELECT question index is reported 1-based', async (t) => {
  const { host, app } = await setup(t);
  // The row shows a question but its event is out of reach, so choices pass through unchecked.
  host.setRow('cond-a', { awaitingUser: 'question', awaitingUserSource: 'tool' });
  for (const index of [0, 2]) {
    host.setMcp('answer_question', () => mcpSoft('NOT_MULTISELECT', `Question ${index} is single-choice; use { option } not { options }.`, { questionIndex: index }));
    const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['1', '2'] }] });
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
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: BIG, frames: false });
  host.mcpCalls.length = 0;
  const read = await callTool(app, 'read_conductor_messages', { session: 'cond-a' });
  assert.equal(read.messages[0].questionCount, 10);
  assert.equal(read.messages[0].questionsTruncated, true);
  assert.ok(read.messages[0].text.length <= 4000);
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: BIG.map((_, i) => ({ choices: [i === 9 ? '6' : '1'] })) });
  assert.equal(r.ok, true);
  const sent = called(host, 'answer_question')[0].arguments.answers;
  assert.deepEqual(sent[9], { option: 'Q10-Option-6' }, 'option 6 of question 10 resolves though the announced text had to shorten it');
  assert.equal(sent.length, 10);
});

test('a read of questions that fit carries no truncation flag', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.equal('questionsTruncated' in m, false);
});

test('a sub-agent question event is not the conductor\'s pending question', async (t) => {
  const { host, app } = await setup(t);
  host.finishAsk('cond-a', { kind: 'question', questions: QUESTIONS, frames: false });
  // A later sub-agent question with other labels must not be the one answers map against.
  host.addEvent('cond-a', { kind: 'user_question', parentToolUseId: 'toolu_task', toolUseId: 'sub', questions: [{ question: 'Sub?', options: [{ label: 'Other' }] }] });
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  const r = await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['sqlite'] }, { choices: ['test'] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(called(host, 'answer_question')[0].arguments.answers, [{ option: 'SQLite' }, { options: ['Test'] }]);
});

test('a read of options that had to be dropped says so, and answering still reaches the dropped options by number', async (t) => {
  const { host, app } = await setup(t);
  const many = [{ question: 'Which?', multiSelect: false, options: Array.from({ length: 400 }, (_, i) => ({ label: `Opt ${i}`, description: 'desc '.repeat(20) })) }];
  host.finishAsk('cond-a', { kind: 'question', questions: many, frames: false });
  const [m] = (await callTool(app, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.equal(m.questionsTruncated, true);
  assert.equal(m.questionsDropped, true);
  assert.match(m.text, /more line\(s\) not shown$/);
  host.setMcp('answer_question', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 't' }));
  assert.equal((await callTool(app, 'answer_conductor_question', { session: 'cond-a', answers: [{ choices: ['400'] }] })).ok, true);
  assert.deepEqual(called(host, 'answer_question')[0].arguments.answers, [{ option: 'Opt 399' }]);
  // Shortened only: no dropped flag.
  const { host: host2, app: app2 } = await setup(t);
  host2.finishAsk('cond-a', { kind: 'question', questions: BIG, frames: false });
  const [short] = (await callTool(app2, 'read_conductor_messages', { session: 'cond-a' })).messages;
  assert.equal(short.questionsTruncated, true);
  assert.equal('questionsDropped' in short, false);
});
