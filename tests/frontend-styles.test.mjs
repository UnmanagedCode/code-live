// Pins: public/styles.css is dark-only, declares code-conductor's shell token
// names on :root, references no custom property it doesn't declare there, and
// renders disabled buttons like the host: emphasized ones swap to its
// panel-2/muted look, and every one fades with a not-allowed cursor. The
// textarea is styled like the other fields, and a disabled select or textarea
// fades the same way. The Settings pane has one spacing rhythm: flex gap owns
// every vertical space (1rem between groups, .5rem inside one), hints and
// statuses share one muted style, and no settings rule sets a margin.
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

test('textarea is styled like the other fields and shares their focus ring', () => {
  const decls = declarationsOf('select, input, textarea');
  assert.ok(decls, 'styles.css has no select, input, textarea rule');
  assert.equal(decls.background, 'var(--panel-2)');
  assert.equal(decls.color, 'var(--text)');
  assert.equal(decls.border, '1px solid var(--border)');
  const focus = declarationsOf('input:focus, select:focus, textarea:focus, button:focus-visible');
  assert.ok(focus, 'the focus rule does not include textarea:focus');
  assert.equal(focus.outline, '2px solid var(--accent)');
});

test('a disabled select or textarea fades like a disabled button', () => {
  const decls = declarationsOf('select:disabled, textarea:disabled');
  assert.ok(decls, 'styles.css has no select:disabled, textarea:disabled rule');
  assert.equal(decls.opacity, '.5');
  assert.equal(decls.cursor, 'not-allowed');
});

// Invariant: groups are 1rem apart, from a gap on the body (no sibling margins),
// and the first group sits .5rem below the summary, from the body's padding-top.
test('settings body stacks groups with a 1rem gap', () => {
  const decls = declarationsOf('.settings-body');
  assert.ok(decls, 'styles.css has no .settings-body rule');
  assert.equal(decls.display, 'flex');
  assert.equal(decls['flex-direction'], 'column');
  assert.equal(decls.gap, '1rem');
  assert.equal(decls['padding-top'], '.5rem');
});

// Invariant: items inside a group are .5rem apart, from a gap on the group.
test('settings groups stack their items with a .5rem gap', () => {
  const decls = declarationsOf('.settings-group');
  assert.ok(decls, 'styles.css has no .settings-group rule');
  assert.equal(decls.display, 'flex');
  assert.equal(decls['flex-direction'], 'column');
  assert.equal(decls.gap, '.5rem');
});

// Invariant: hints and statuses look alike (muted, small, no UA margin) and
// the error colour still wins by coming later in the sheet.
test('settings hints and statuses share one muted style with no margins', () => {
  const shared = '.settings-pane .hint, .settings-pane .settings-status';
  const decls = declarationsOf(shared);
  assert.ok(decls, `styles.css has no ${shared} rule`);
  assert.equal(decls.margin, '0');
  assert.equal(decls.color, 'var(--muted)');
  assert.equal(decls['font-size'], '.85rem');
  assert.equal(declarationsOf('.settings-status.error').color, 'var(--bad)');
  assert.ok(css.indexOf('.settings-status.error') > css.indexOf(shared), 'the error colour must follow the shared muted rule');
});

// Invariant: a status with no text adds no flex gap under its control.
test('an empty settings status takes no space', () => {
  const decls = declarationsOf('.settings-status:empty');
  assert.ok(decls, 'styles.css has no .settings-status:empty rule');
  assert.equal(decls.display, 'none');
});

// Invariant: gap is the only source of settings spacing; no margin returns.
test('gap owns settings spacing: no settings rule sets a non-zero margin', () => {
  let checked = 0;
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!sel.includes('settings')) continue;
    for (const [prop, value] of body.split(';').map((d) => d.split(':').map((x) => x.trim()))) {
      if (!prop?.startsWith('margin')) continue;
      checked++;
      assert.equal(value, '0', `${sel.trim()} sets ${prop}: ${value}`);
    }
  }
  assert.ok(checked > 0, 'no settings margin declaration was found to check');
});
