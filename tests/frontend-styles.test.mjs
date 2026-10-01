// Pins: public/styles.css is dark-only, declares code-conductor's shell token
// names on :root, references no custom property it doesn't declare there, and
// renders disabled buttons like the host: emphasized ones swap to its
// panel-2/muted look, and every one fades with a not-allowed cursor.
// Reads the stylesheet as text: happy-dom doesn't resolve cascaded custom
// properties reliably.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
const root = rootMatch ? rootMatch[1] : '';
const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Declarations of the rule whose selector list is exactly `selector`.
function declarationsOf(selector) {
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (sel.trim() !== selector) continue;
    return Object.fromEntries(body.split(';').map((d) => d.split(':').map((x) => x.trim())).filter(([prop]) => prop));
  }
  return null;
}

test(':root block exists', () => {
  assert.ok(rootMatch, 'styles.css has no :root block');
});

test('dark-only: no prefers-color-scheme query, :root declares color-scheme: dark', () => {
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(root, /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/);
});

test("declares the host shell's token names on :root", () => {
  for (const name of ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border', '--accent']) {
    assert.ok(declared.has(name), `:root does not declare ${name}`);
  }
});

test('every var(--name) used is declared on :root', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) assert.ok(declared.has(name), `var(${name}) is not declared on :root`);
});

test("disabled emphasized buttons swap to the host's panel-2/muted look", () => {
  const decls = declarationsOf('button:not(.secondary):disabled');
  assert.ok(decls, 'styles.css has no button:not(.secondary):disabled rule');
  assert.equal(decls.background, 'var(--panel-2)');
  assert.equal(decls.color, 'var(--muted)');
  assert.equal(decls['border-color'], 'var(--border)');
  assert.equal(decls['font-weight'], '400');
});

test("disabled buttons fade like the host's generic button:disabled", () => {
  const decls = declarationsOf('button:disabled');
  assert.ok(decls, 'styles.css has no button:disabled rule');
  assert.equal(decls.opacity, '.5');
  assert.equal(decls.cursor, 'not-allowed');
});
