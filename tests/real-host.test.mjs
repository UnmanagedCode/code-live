// Real code-conductor smoke test, skipped unless RUN_REAL_HOST=1. It makes
// only non-mutating calls (the events route, and /mcp get_recent_messages as the
// reference the events assembly is compared with; src/ itself never calls it):
//   RUN_REAL_HOST=1 CONDUCTOR_URL=http://127.0.0.1:<port> REAL_HOST_SESSION=<a live session's public sessionId> \
//     node tests/run.mjs tests/real-host.test.mjs
// Pins: the real host's bare /mcp still answers a stateless tools/call with
// the envelope hostMcp parses, and rejects bad arguments before any handler
// runs, and the messages assembled from the events route match the host's own
// message reconstruction, so a host change that breaks either surface shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostMcp } from '../src/hostMcp.js';
import { createCcApi } from '../src/ccApi.js';
import { readBack } from '../src/eventPages.js';
import { assembleMessages } from '../src/eventMessages.js';

const RUN = process.env.RUN_REAL_HOST === '1';
const opts = { skip: RUN ? false : 'set RUN_REAL_HOST=1 (with CONDUCTOR_URL and REAL_HOST_SESSION) to run' };

function hostMcp() {
  const baseUrl = process.env.CONDUCTOR_URL;
  const sessionId = process.env.REAL_HOST_SESSION;
  assert.ok(baseUrl && sessionId, 'CONDUCTOR_URL and REAL_HOST_SESSION are required');
  return { mcp: createHostMcp({ baseUrl }), sessionId };
}

// Invariant: for the latest messages of a real session, the prose assembled from the events route has the length the
// host reports (`textChars`), and hasPlan / questionCount agree, matched by msgId.
test('events assembly matches the host message reconstruction', opts, async () => {
  const baseUrl = process.env.CONDUCTOR_URL;
  const sessionId = process.env.REAL_HOST_SESSION;
  assert.ok(baseUrl && sessionId, 'CONDUCTOR_URL and REAL_HOST_SESSION are required');
  const api = createCcApi({ baseUrl });
  const row = (await api.listInstances()).find((i) => i.sessionId === sessionId);
  assert.ok(row, 'REAL_HOST_SESSION names no live session');
  const { events, complete } = await readBack(api, row.id, { enough: (evs) => assembleMessages(evs).length > 6 });
  const assembled = assembleMessages(events).slice(complete ? 0 : 1);
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_recent_messages', arguments: { sessionId, count: 5 } } }),
  });
  const meta = JSON.parse((await res.json()).result.content[0].text);
  const byId = new Map(assembled.map((m) => [m.msgId, m]));
  const matched = meta.messages.filter((m) => byId.has(m.msgId));
  assert.ok(matched.length > 0, 'at least one of the host messages is in the assembled window');
  for (const m of matched) {
    const mine = byId.get(m.msgId);
    assert.equal(mine.prose.length, m.textChars, `prose length of ${m.msgId}`);
    assert.equal(mine.hasPlan, !!m.hasPlan, `hasPlan of ${m.msgId}`);
    assert.equal(mine.questions?.length ?? 0, m.questionCount ?? 0, `questionCount of ${m.msgId}`);
  }
});

test('answer_question with malformed answers is rejected by argument validation', opts, async () => {
  const { mcp, sessionId } = hostMcp();
  await assert.rejects(mcp.answerQuestion(sessionId, 'x'), { code: 'HOST_MCP_ERROR' });
});
