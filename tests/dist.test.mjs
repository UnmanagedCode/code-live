// Checks the real build (`npm install` runs `prepare`, which writes
// frontend/dist): it is what the CSP actually meets, and what the backend serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SERVED_NAME } from '../src/http.js';
import { startFakeGemini } from './fakes/fakeGemini.mjs';
import { startApp, req } from './helpers.mjs';
import { FRONTEND, headAssets, HOST_URLS } from './frontendFiles.mjs';

const DIST = path.join(FRONTEND, 'dist');
const indexPath = path.join(DIST, 'index.html');
const built = existsSync(indexPath);
const files = [];
const walk = (rel) => {
  for (const e of readdirSync(path.join(DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(r); else files.push(r);
  }
};
if (built) walk('');
const html = built ? readFileSync(indexPath, 'utf8') : '';
const read = (rel) => readFileSync(path.join(DIST, rel), 'utf8');
const refs = () => [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);

// Invariant: the UI is built (by `npm install`).
test('frontend/dist/index.html exists', () => {
  assert.ok(built, `${indexPath} is missing — run npm run prepare`);
});

// Invariant: every built file is servable by the static allowlist, at the root or under assets/, and is html/js/css only.
test('every built file matches the served-name rule', () => {
  assert.ok(files.length >= 5, files.join(', '));
  for (const f of files) {
    const [dir, name] = f.includes('/') ? f.split('/') : ['', f];
    assert.ok(dir === '' || dir === 'assets', `${f}: only the root and assets/ are served`);
    assert.match(name, SERVED_NAME, f);
  }
  assert.equal(files.some((f) => f.endsWith('.map')), false, 'no source maps');
  assert.ok(files.some((f) => /^assets\/.+\.js$/.test(f)), 'a JS bundle');
  assert.ok(files.some((f) => /^assets\/.+\.css$/.test(f)), 'a CSS bundle');
  for (const f of ['theme-init.js', 'mic-worklet.js']) assert.ok(files.includes(f), f);
  assert.equal(read('mic-worklet.js'), readFileSync(path.join(FRONTEND, 'public', 'mic-worklet.js'), 'utf8'), 'the worklet is copied verbatim');
});

// Invariant: the built page has no inline script or style, and only relative URLs besides the two host URLs, in the recipe's head order.
test('built index.html: no inline script/style, relative URLs, head order kept', () => {
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline <script>');
  assert.equal(/<style[\s>]/.test(html), false, '<style>');
  assert.equal(/\sstyle\s*=/.test(html), false, 'style=');
  assert.equal(/\son[a-z]+=/i.test(html), false, 'on*= handler');
  for (const u of refs()) {
    if (HOST_URLS.includes(u)) continue;
    assert.ok(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(u), `not relative: ${u}`);
  }
  const order = headAssets(html);
  assert.deepEqual(order.slice(0, 3), [...HOST_URLS, 'theme-init.js']);
  assert.match(order[3], /^\.\/assets\/index-[A-Za-z0-9_-]+\.js$/);
});

// Invariant: the CSS loads nothing the CSP forbids (no URL at all: fonts come from the host sheet); the JS calls no root-relative API.
test('built CSS and JS reference nothing off-limits', () => {
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/url\(/i.test(css), false, `${f}: url(`);
    assert.equal(/https?:\/\//i.test(css), false, `${f}: absolute URL`);
  }
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    assert.equal(/["'`]\/api\//.test(read(f)), false, `${f}: root-relative /api/`);
  }
});

// Invariant: the backend serves the real build: / and every file it references, with type and CSP.
test('the server serves the built page and its assets', async (t) => {
  const gemini = await startFakeGemini();
  const app = await startApp({ gemini, startLink: false });
  t.after(async () => { await app.stop(); await gemini.close(); });
  assert.equal(app.deps.uiBuilt, true);
  const r = await req(`${app.url}/`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /^default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; /);
  assert.equal(r.text, html);
  const local = [...refs().filter((u) => !HOST_URLS.includes(u)), 'mic-worklet.js'];
  assert.ok(local.length >= 4, local.join(', '));
  for (const u of local) {
    const a = await req(new URL(u, `${app.url}/`).href);
    assert.equal(a.status, 200, u);
    assert.equal(a.headers.get('content-type'), `${u.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`, u);
    assert.equal(a.headers.get('content-security-policy'), csp, u);
    assert.equal(a.headers.get('x-content-type-options'), 'nosniff', u);
  }
  for (const u of HOST_URLS) assert.equal((await req(`${app.url}${u}`)).status, 404, `${u} 404s standalone`);
});
