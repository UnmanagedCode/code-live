// Real code-conductor smoke test, skipped unless RUN_REAL_HOST=1. It makes
// only non-mutating calls:
//   RUN_REAL_HOST=1 CONDUCTOR_URL=http://127.0.0.1:<port> REAL_HOST_SESSION=<a live session's public sessionId> \
//     node tests/run.mjs tests/real-host.test.mjs
// Pins: the real host's bare /mcp still answers a stateless tools/call with
// the envelope hostMcp parses, and rejects bad arguments before any handler
// runs, so a host change that breaks the unsanctioned surface shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostMcp, pairMessages } from '../src/hostMcp.js';

const RUN = process.env.RUN_REAL_HOST === '1';
const opts = { skip: RUN ? false : 'set RUN_REAL_HOST=1 (with CONDUCTOR_URL and REAL_HOST_SESSION) to run' };

function hostMcp() {
  const baseUrl = process.env.CONDUCTOR_URL;
  const sessionId = process.env.REAL_HOST_SESSION;
  assert.ok(baseUrl && sessionId, 'CONDUCTOR_URL and REAL_HOST_SESSION are required');
  return { mcp: createHostMcp({ baseUrl }), sessionId };
}

test('get_recent_messages parses through the real /mcp envelope', opts, async () => {
  const { mcp, sessionId } = hostMcp();
  const recent = await mcp.recentMessages(sessionId);
  assert.equal(typeof recent.meta.sessionId, 'string');
  assert.ok(Array.isArray(recent.meta.messages));
  assert.equal(recent.bodies.length, recent.meta.messages.length);
  assert.equal(pairMessages(recent).length, recent.meta.messages.length);
});

test('answer_question with malformed answers is rejected by argument validation', opts, async () => {
  const { mcp, sessionId } = hostMcp();
  await assert.rejects(mcp.answerQuestion(sessionId, 'x'), { code: 'HOST_MCP_ERROR' });
});
