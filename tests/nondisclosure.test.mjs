// Pins: once stored, the Gemini key never leaves the backend except in the
// x-goog-api-key header to Gemini. Every route in ROUTES (a new route fails
// this test until it is probed here), every static file, and the error paths
// are checked for the key and its prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import { ROUTES } from '../src/routes.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startFakeHost } from './fakes/fakeHost.mjs';
import { startApp, req, SENTINEL_KEY, CONDUCTOR_A, WORKER } from './helpers.mjs';

const PREFIX = SENTINEL_KEY.slice(0, 12);

function firstSseChunk(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, (res) => {
      res.setEncoding('utf8');
      res.once('data', (chunk) => { resolve({ status: res.statusCode, headers: res.headers, text: chunk }); r.destroy(); });
    });
    r.on('error', reject);
  });
}

test('the stored key never appears in any response', async (t) => {
  const gemini = await startFakeGemini();
  const host = await startFakeHost({ instances: [CONDUCTOR_A, WORKER] });
  const app = await startApp({ gemini, host });
  t.after(async () => { await app.stop(); await host.close(); await gemini.close(); });
  await app.deps.keyStore.set(SENTINEL_KEY);
  const u = (p) => `${app.url}${p}`;
  const setKey = () => req(u('/api/settings/api-key'), { method: 'PUT', body: { apiKey: SENTINEL_KEY } });

  const probes = {
    'GET /api/health': () => [req(u('/api/health'))],
    'GET /api/settings': async () => {
      const r = await req(u('/api/settings'));
      assert.deepEqual(r.json, { apiKey: { set: true, tail: 'cdef' } });
      return [r];
    },
    'PUT /api/settings/api-key': async () => [
      await setKey(),
      await req(u('/api/settings/api-key'), { method: 'PUT', body: { apiKey: `bad ${SENTINEL_KEY}` } }),
      await req(u('/api/settings/api-key'), { method: 'PUT', raw: SENTINEL_KEY, headers: { 'content-type': 'text/plain' } }),
      await req(u('/api/settings/api-key'), { method: 'PUT', raw: `{"apiKey":"${SENTINEL_KEY}"`, headers: { 'content-type': 'application/json' } }),
    ],
    'DELETE /api/settings/api-key': async () => [await req(u('/api/settings/api-key'), { method: 'DELETE' }), await setKey()],
    'GET /api/models': () => [req(u('/api/models'))],
    'POST /api/token': async () => {
      const ok = await req(u('/api/token'), { method: 'POST', body: { model: 'gemini-3.8-live' } });
      assert.equal(ok.status, 200);
      gemini.setMintFailure({ status: 400, body: { error: { message: `API key not valid. ${SENTINEL_KEY} (${PREFIX})` } } });
      const upstream = await req(u('/api/token'), { method: 'POST', body: { model: 'gemini-3.8-live' } });
      gemini.setMintFailure(null);
      assert.equal(upstream.status, 502);
      return [ok, upstream, await req(u('/api/token'), { method: 'POST', body: { model: 'nope' } })];
    },
    'POST /api/tools/call': async () => [
      await req(u('/api/tools/call'), { method: 'POST', body: { name: 'list_conductor_sessions' } }),
      await req(u('/api/tools/call'), { method: 'POST', body: { name: 'send_to_conductor', args: { text: SENTINEL_KEY.slice(0, 3), session: 'worker-1' } } }),
      await req(u('/api/tools/call'), { method: 'POST', body: { name: 'nope' } }),
      await req(u('/api/tools/call'), { method: 'POST', body: { name: 1 } }),
    ],
    'GET /api/events': async () => [await firstSseChunk(u('/api/events'))],
  };
  assert.deepEqual(Object.keys(probes).sort(), ROUTES.map((r) => `${r.method} ${r.path}`).sort(), 'every route is probed');

  const responses = [];
  for (const probe of Object.values(probes)) responses.push(...await Promise.all(await probe()));
  for (const f of readdirSync(new URL('../public/', import.meta.url))) responses.push(await req(u(`/${f}`)));
  responses.push(await req(u('/missing')), await req(u('/')));

  assert.ok(responses.length > 30);
  for (const r of responses) {
    const headers = r.headers instanceof Headers ? JSON.stringify([...r.headers]) : JSON.stringify(r.headers);
    for (const needle of [SENTINEL_KEY, PREFIX]) {
      assert.ok(!r.text.includes(needle), `body leaked the key: ${r.text.slice(0, 200)}`);
      assert.ok(!headers.includes(needle), 'headers leaked the key');
    }
  }
  assert.equal(await app.deps.keyStore.get(), SENTINEL_KEY, 'the probes left the key stored');
});
