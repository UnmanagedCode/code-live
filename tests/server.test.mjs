// Pins: every response (static, API, 404, 503, 500, SSE) carries the exact CSP
// and the nosniff / no-referrer / no-store headers; the built UI is served only
// from the dist root and assets/ under the served-name rule, with no SPA
// fallback; an unbuilt UI answers its page with a plain-text 503 while the API
// stays up; and request bodies are gated by content type, size and JSON validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startApp, req, fixtureDist, tempDir } from './helpers.mjs';

async function setup(t, { distDir } = {}) {
  const gemini = await startFakeGemini();
  const dist = distDir ?? await fixtureDist();
  const app = await startApp({ gemini, startLink: false, distDir: dist });
  t.after(async () => { await app.stop(); await gemini.close(); await fs.rm(dist, { recursive: true, force: true }); });
  return { gemini, app };
}

// Raw request so the target reaches the server exactly as written.
function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function sseHeaders(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, (res) => { resolve({ status: res.statusCode, headers: res.headers }); r.destroy(); });
    r.on('error', reject);
  });
}

const cspFor = (gemini) => `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self' ${gemini.base.replace('http://', 'ws://')}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;

function assertSecurityHeaders(r, csp, what) {
  const get = (h) => (r.headers.get ? r.headers.get(h) : r.headers[h]);
  assert.equal(get('content-security-policy'), csp, what);
  assert.equal(get('x-content-type-options'), 'nosniff', what);
  assert.equal(get('referrer-policy'), 'no-referrer', what);
  assert.equal(get('cache-control'), 'no-store', what);
}

test('security headers on every kind of response', async (t) => {
  const { gemini, app } = await setup(t);
  const csp = cspFor(gemini);
  const probes = [['/'], ['/assets/index-Ab_1-z.js'], ['/mic-worklet.js'], ['/api/health'], ['/nope'], ['/pluginBridge.js'],
    ['/api/token', { method: 'POST', body: { model: 'x' } }]];
  for (const [p, init] of probes) assertSecurityHeaders(await req(`${app.url}${p}`, init), csp, p);
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
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(index.text, '<!doctype html><title>fixture</title>');
  assert.equal((await req(`${app.url}/index.html`)).text, index.text);
  for (const [p, type, text] of [
    ['/assets/index-Ab_1-z.js', /^text\/javascript/, '/* bundle */'],
    ['/assets/index-Cd2.css', /^text\/css/, '/* styles */'],
    ['/mic-worklet.js', /^text\/javascript/, '/* worklet */'],
    ['/theme-init.js', /^text\/javascript/, '/* theme */'],
  ]) {
    const r = await req(`${app.url}${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.equal(r.text, text, p);
  }
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/src/config.js', '/nope.js', '/assets/index-Ab_1-z.js.map',
    '/assets/nested/deep.js', '/notes.txt', '/a.b.js', '/.hidden.js', '/sub/x.js', '/assets/', '/assets',
    '/frontend/dist/index.html', '/pluginBridge.js', '/pluginTheme.css', '/plugins/code-live/']) {
    const r = await req(`${app.url}${p}`);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'not found', code: 'NOT_FOUND' }, p);
  }
});

test('an unbuilt UI answers its page with a plain-text 503 and keeps the API up', async (t) => {
  // Two unbuilt shapes: no dist directory at all, and assets with no index.html (nothing of it is served).
  const empty = await tempDir();
  await fs.mkdir(path.join(empty, 'assets'));
  await fs.writeFile(path.join(empty, 'assets', 'index-Ab.js'), '/* orphan */');
  for (const distDir of [path.join(empty, 'missing'), empty]) {
    const { gemini, app } = await setup(t, { distDir });
    assert.equal(app.deps.uiBuilt, false);
    const csp = cspFor(gemini);
    for (const p of ['/', '/index.html']) {
      const r = await req(`${app.url}${p}`);
      assert.equal(r.status, 503, p);
      assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
      assert.equal(r.text, 'UI not built — run npm install');
      assertSecurityHeaders(r, csp, p);
    }
    const head = await req(`${app.url}/`, { method: 'HEAD' });
    assert.equal(head.status, 503);
    for (const p of ['/assets/index-Ab.js', '/pluginTheme.css']) assert.equal((await req(`${app.url}${p}`)).status, 404, p);
    const health = await req(`${app.url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });
    assert.equal((await req(`${app.url}/api/models`)).status, 200);
  }
});

test('a 500 carries the security headers too', async (t) => {
  // A corrupt preferences.json makes GET /api/settings fail with STORE_CORRUPT.
  const { gemini, app } = await setup(t);
  await app.deps.prefs.setVoice('Kore');
  await fs.writeFile(app.deps.prefs.file, '{"voice":"Nope"}');
  const r = await req(`${app.url}/api/settings`);
  assert.equal(r.status, 500);
  assert.equal(r.json.code, 'STORE_CORRUPT');
  assertSecurityHeaders(r, cspFor(gemini), '500');
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

test('a malformed request target is a 400 and the server keeps serving', async (t) => {
  const { gemini, app } = await setup(t);
  const port = new URL(app.url).port;
  const csp = (await req(`${app.url}/api/health`)).headers.get('content-security-policy');
  for (const target of ['//', '///', '//?x=1']) {
    const r = await rawGet(port, target);
    assert.equal(r.status, 400, target);
    assert.deepEqual(JSON.parse(r.body), { error: 'malformed request target', code: 'BAD_REQUEST' });
    assert.equal(r.headers['content-security-policy'], csp);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.ok(csp.includes(gemini.base.replace('http://', 'ws://')));
  const health = await req(`${app.url}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });
});
