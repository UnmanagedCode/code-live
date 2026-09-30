// Pins: hostMcp is the only place that speaks bare `POST /mcp`: one stateless
// tools/call per request with an incrementing id, the multi-block
// get_recent_messages result parsed into {meta, bodies}, and every failure
// shape (soft refusal, isError, JSON-RPC error, HTTP error, network, timeout)
// surfaced as a coded error that never reads as success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHost, mcpOk, mcpSoft, mcpThrown } from './fakes/fakeHost.mjs';
import { createHostMcp, pairMessages } from '../src/hostMcp.js';
import { CONDUCTOR_A } from './helpers.mjs';

const fetchReturning = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const rpc = (result) => ({ jsonrpc: '2.0', id: 1, result });
const textResult = (obj, extra = {}) => rpc({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra });

async function withHost(t, events) {
  const host = await startFakeHost({ instances: [CONDUCTOR_A], events });
  t.after(() => host.close());
  return { host, mcp: createHostMcp({ baseUrl: host.url }) };
}

test('sends one bare tools/call to /mcp with an incrementing id and no initialize', async (t) => {
  const { host, mcp } = await withHost(t);
  host.setMcp('approve_plan', () => mcpOk({ sessionId: 's-a', mode: 'bypassPermissions', sentText: 'go' }));
  host.setMcp('reject_plan', () => mcpOk({ sessionId: 's-a', mode: 'plan', sentText: 'redo' }));
  await mcp.approvePlan('s-a', 'ship it');
  await mcp.rejectPlan('s-a');
  assert.deepEqual(host.mcpCalls.map((c) => [c.name, c.arguments, c.url]), [
    ['approve_plan', { sessionId: 's-a', feedback: 'ship it' }, '/mcp'],
    ['reject_plan', { sessionId: 's-a' }, '/mcp'],
  ]);
  assert.deepEqual(host.mcpCalls.map((c) => c.id), [1, 2]);
  assert.ok(host.requests.every((q) => q.method === 'POST' && q.url === '/mcp'), 'nothing but tools/call');
});

test('recentMessages parses the multi-block result into meta and bodies, without a count by default', async (t) => {
  const { host, mcp } = await withHost(t, {
    'cond-a': [{ kind: 'assistant_message', msgId: 'm1', message: { content: [{ type: 'text', text: 'first' }] } }, { kind: 'assistant_message', msgId: 'm2', message: { content: [{ type: 'text', text: 'second' }] } }],
  });
  const { meta, bodies } = await mcp.recentMessages('s-a');
  assert.deepEqual(host.mcpCalls[0].arguments, { sessionId: 's-a' }, 'no count: the host bonds the default selection');
  assert.equal(meta.sessionId, 's-a');
  assert.deepEqual(meta.messages.map((m) => m.msgId), ['m2']);
  assert.deepEqual(bodies, ['second']);
  await mcp.recentMessages('s-a', { count: 2 });
  assert.deepEqual(host.mcpCalls[1].arguments, { sessionId: 's-a', count: 2 });
  const two = await mcp.recentMessages('s-a', { count: 2 });
  assert.match(two.bodies[0], /^--- message 1\/2 · m1 · 5 chars ---\nfirst$/);
  assert.deepEqual(pairMessages(two).map((m) => m.text), ['first', 'second'], 'the boundary line is dropped');
});

test('pairMessages carries msgId and the plan and question markers', () => {
  const meta = { messages: [{ msgId: 'a', hasPlan: true, planPath: '/p/plan.md' }, { msgId: 'b', questionCount: 2 }, { msgId: 'c' }] };
  assert.deepEqual(pairMessages({ meta, bodies: ['one', 'two', 'three'] }), [
    { msgId: 'a', text: 'one', hasPlan: true, planPath: '/p/plan.md' },
    { msgId: 'b', text: 'two', questionCount: 2 },
    { msgId: 'c', text: 'three' },
  ]);
});

test('a soft refusal throws its code with the reason and the remaining fields', async (t) => {
  const { host, mcp } = await withHost(t);
  host.setMcp('answer_question', () => mcpSoft('INVALID_OPTION', 'not offered', { questionIndex: 1, invalid: ['x'], offered: ['A', 'B'] }));
  await assert.rejects(mcp.answerQuestion('s-a', [{}]), (e) => {
    assert.equal(e.code, 'INVALID_OPTION');
    assert.equal(e.message, 'not offered');
    assert.deepEqual(e.detail, { questionIndex: 1, invalid: ['x'], offered: ['A', 'B'] });
    return true;
  });
});

test('an isError result is HOST_MCP_ERROR carrying the host prose', async (t) => {
  const { host, mcp } = await withHost(t);
  host.setMcp('approve_plan', () => mcpThrown('failed to switch session s-a to bypassPermissions: boom', { code: 'X' }));
  await assert.rejects(mcp.approvePlan('s-a'), (e) => e.code === 'HOST_MCP_ERROR' && /failed to switch session s-a.*boom/.test(e.message));
  // An unknown tool is the same shape.
  const unknown = createHostMcp({ baseUrl: host.url });
  host.setMcp('reject_plan', () => mcpThrown('unknown tool: reject_plan'));
  await assert.rejects(unknown.rejectPlan('s-a'), { code: 'HOST_MCP_ERROR' });
});

test('a JSON-RPC error, an HTTP error and an unreadable body are coded, not success', async () => {
  const rpcErr = createHostMcp({ baseUrl: 'http://h', fetchImpl: fetchReturning(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }) });
  await assert.rejects(rpcErr.recentMessages('s'), (e) => e.code === 'HOST_MCP_ERROR' && /bad params/.test(e.message));
  const http500 = createHostMcp({ baseUrl: 'http://h', fetchImpl: fetchReturning(500, 'oops') });
  await assert.rejects(http500.recentMessages('s'), { code: 'HOST_HTTP_ERROR' });
  const junk = createHostMcp({ baseUrl: 'http://h', fetchImpl: fetchReturning(200, 'not json') });
  await assert.rejects(junk.recentMessages('s'), { code: 'HOST_MCP_ERROR' });
  const notJsonContent = createHostMcp({ baseUrl: 'http://h', fetchImpl: fetchReturning(200, rpc({ content: [{ type: 'text', text: 'plain' }] })) });
  await assert.rejects(notJsonContent.approvePlan('s'), { code: 'HOST_MCP_ERROR' });
  await assert.rejects(notJsonContent.recentMessages('s'), { code: 'HOST_MCP_ERROR' });
});

test('a network failure is HOST_UNAVAILABLE', async () => {
  const mcp = createHostMcp({ baseUrl: 'http://h', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(mcp.recentMessages('s'), (e) => e.code === 'HOST_UNAVAILABLE' && /ECONNREFUSED/.test(e.message));
});

test('a timeout is HOST_TIMEOUT; for a mutation it warns the call may have been delivered', async () => {
  const never = () => new Promise(() => {});
  const mcp = createHostMcp({ baseUrl: 'http://h', fetchImpl: never, timeoutMs: 20 });
  const read = await mcp.recentMessages('s').catch((e) => e);
  assert.equal(read.code, 'HOST_TIMEOUT');
  assert.doesNotMatch(read.message, /delivered/);
  for (const call of [() => mcp.approvePlan('s'), () => mcp.rejectPlan('s'), () => mcp.answerQuestion('s', [{}])]) {
    const e = await call().catch((err) => err);
    assert.equal(e.code, 'HOST_TIMEOUT');
    assert.match(e.message, /may have been delivered.*do not resend/);
  }
});

test('a response whose body never arrives also times out', async () => {
  const mcp = createHostMcp({ baseUrl: 'http://h', timeoutMs: 20, fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
  await assert.rejects(mcp.recentMessages('s'), { code: 'HOST_TIMEOUT' });
});

test('the request body is a JSON-RPC 2.0 tools/call envelope', async () => {
  let sent;
  const mcp = createHostMcp({ baseUrl: 'http://h:1', fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(textResult({ sessionId: 's', mode: 'plan', sentText: 't' }))); } });
  await mcp.rejectPlan('s', 'redo it');
  assert.equal(sent.url, 'http://h:1/mcp');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.init.body), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reject_plan', arguments: { sessionId: 's', feedback: 'redo it' } } });
});
