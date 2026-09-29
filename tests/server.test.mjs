// Pins: every response (static, API, 404, SSE) carries the exact CSP and the
// nosniff / no-referrer / no-store headers, and request bodies are gated by
// content type, size and JSON validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startApp, req } from './helpers.mjs';

async function setup(t) {
  const gemini = await startFakeGemini();
  const app = await startApp({ gemini, startLink: false });
  t.after(async () => { await app.stop(); await gemini.close(); });
  return { gemini, app };
}

function sseHeaders(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, (res) => { resolve({ status: res.statusCode, headers: res.headers }); r.destroy(); });
    r.on('error', reject);
  });
}

test('security headers on every kind of response', async (t) => {
  const { gemini, app } = await setup(t);
  const origin = gemini.base.replace('http://', 'ws://');
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
  const responses = [
    await req(`${app.url}/`),
    await req(`${app.url}/app.js`),
    await req(`${app.url}/api/health`),
    await req(`${app.url}/nope`),
    await req(`${app.url}/api/token`, { method: 'POST', body: { model: 'x' } }),
  ];
  for (const r of responses) {
    assert.equal(r.headers.get('content-security-policy'), csp);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const sse = await sseHeaders(`${app.url}/api/events`);
  assert.equal(sse.headers['content-security-policy'], csp);
  assert.equal(sse.headers['x-content-type-options'], 'nosniff');
  assert.equal(sse.headers['cache-control'], 'no-store');
  assert.match(sse.headers['content-type'], /^text\/event-stream/);
});

test('the production CSP allows only the Gemini Live origin', async () => {
  const { securityHeaders } = await import('../src/http.js');
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ PROJECTS_ROOT: '/r', CONDUCTOR_URL: 'http://127.0.0.1:1' });
  assert.match(securityHeaders(c.geminiWsUrl)['content-security-policy'], /connect-src 'self' wss:\/\/generativelanguage\.googleapis\.com;/);
});

test('health, static content types and 404s', async (t) => {
  const { app } = await setup(t);
  const health = await req(`${app.url}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });
  assert.match(health.headers.get('content-type'), /^application\/json/);
  const index = await req(`${app.url}/`);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal((await req(`${app.url}/index.html`)).text, index.text);
  assert.match((await req(`${app.url}/app.js`)).headers.get('content-type'), /^text\/javascript/);
  assert.match((await req(`${app.url}/styles.css`)).headers.get('content-type'), /^text\/css/);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/src/config.js', '/nope.js']) {
    const r = await req(`${app.url}${p}`);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'not found', code: 'NOT_FOUND' });
  }
});

test('JSON body gates: 415, 413, 400', async (t) => {
  const { app } = await setup(t);
  const url = `${app.url}/api/tools/call`;
  let r = await req(url, { method: 'POST', raw: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  assert.equal(r.json.code, 'UNSUPPORTED_MEDIA_TYPE');
  r = await req(url, { method: 'POST', raw: JSON.stringify({ name: 'x', pad: 'a'.repeat(70 * 1024) }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 413);
  r = await req(url, { method: 'POST', raw: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID_JSON');
  r = await req(url, { method: 'POST', raw: '[1]', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
});
