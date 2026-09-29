// Real Gemini Live smoke test, skipped unless RUN_REAL_GEMINI=1. The key comes
// only from the GEMINI_API_KEY env var:
//   RUN_REAL_GEMINI=1 GEMINI_API_KEY=… node tests/run.mjs tests/real-gemini.test.mjs
// Pins: for each pinned model the backend's locked-setup token connects, the
// browser client goes live, a function call round-trips and injected text
// produces a spoken turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createGemini } from '../src/gemini.js';
import { MODELS } from '../src/models.js';
import { createLiveSession } from '../public/liveSession.js';

const RUN = process.env.RUN_REAL_GEMINI === '1';
const TIMEOUT = 60000;

function waitEvent(events, pred, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT);
    const check = () => {
      const hit = events.find(pred);
      if (hit) { clearTimeout(t); resolve(hit); } else setTimeout(check, 50);
    };
    check();
  });
}

for (const model of MODELS) {
  test(`real Gemini Live: ${model.id}`, { skip: !RUN && 'set RUN_REAL_GEMINI=1', timeout: TIMEOUT * 3 }, async () => {
    const key = process.env.GEMINI_API_KEY;
    assert.ok(key, 'GEMINI_API_KEY must be set');
    const config = loadConfig({ PROJECTS_ROOT: '/nonexistent', CONDUCTOR_URL: 'http://127.0.0.1:1' });
    const gemini = createGemini({ base: config.geminiBase, wsUrl: config.geminiWsUrl, keyStore: { get: async () => key } });
    const toolCalls = [];
    const api = {
      mintToken: (m, handle) => gemini.mintToken({ modelId: m, resumeHandle: handle }),
      callTool: async (name, args) => {
        toolCalls.push({ name, args });
        return { ok: true, sessions: [{ sessionId: 'smoke-1', title: 'Smoke test conductor', status: 'idle', active: true }], activeTarget: { sessionId: 'smoke-1', title: 'Smoke test conductor' } };
      },
    };
    const events = [];
    const session = createLiveSession({ api, onEvent: (e) => events.push(e) });
    try {
      await session.connect(model.id);
      assert.equal(session.state, 'live', JSON.stringify(events.filter((e) => e.type === 'state')));

      session.sendText('Call the list_conductor_sessions tool now, then tell me the title of the session in one short sentence.');
      await waitEvent(events, (e) => e.type === 'tool_call' && e.name === 'list_conductor_sessions', 'a list_conductor_sessions tool call');
      await waitEvent(events, (e) => e.type === 'tool_result', 'the tool result');
      await waitEvent(events, (e) => e.type === 'audio', 'spoken audio');

      // The injected announcement must produce a new spoken turn.
      const mark = events.length;
      session.sendText('CONDUCTOR UPDATE from "Smoke test conductor":\nAll tests passed.');
      await waitEvent(events, (e) => events.indexOf(e) >= mark && e.type === 'audio', 'audio after the injected update');
      await waitEvent(events, (e) => events.indexOf(e) >= mark && e.type === 'turn_complete', 'a turnComplete after the injected update');
      assert.ok(toolCalls.length >= 1);
    } finally {
      session.disconnect();
    }
  });
}
