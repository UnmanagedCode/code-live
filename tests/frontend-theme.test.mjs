// Pins the theme wiring: cc's tokens with a standalone fallback for both
// modes, colours only through tokens, and no theme control of the plugin's own.
// Also the Settings pane's one spacing rhythm: gap owns every space between
// its items, nothing sets a margin, and an empty status takes no space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRONTEND, sourceFiles } from './frontendFiles.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel) => readFileSync(path.join(FRONTEND, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const fallback = strip(read('src/cc-theme-fallback.css'));
const indexCss = strip(read('src/index.css'));

// The body of the first `<selector> {…}` block (no nested braces inside).
const block = (css, selector) => css.match(new RegExp(`(?:^|[\\s}])${selector.replace('.', '\\.')}\\s*\\{([^{}]*)\\}`))?.[1];
const declared = (body) => new Set([...(body ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Invariant: the fallback is one @layer base block (so cc's unlayered sheet wins embedded) declaring :root and .dark.
test('cc-theme-fallback.css is wrapped in @layer base and declares :root and .dark', () => {
  assert.match(fallback.trim(), /^@layer base \{[\s\S]*\}$/);
  assert.ok(declared(block(fallback, ':root')).size > 10, ':root tokens');
  assert.ok(declared(block(fallback, '.dark')).size > 10, '.dark tokens');
});

// Invariant: standalone, every token @theme inline maps resolves in light, and every colour token in dark too.
test('every @theme inline token is declared by the fallback, colours in both modes', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(theme, '@theme inline block');
  const light = declared(block(fallback, ':root'));
  const dark = declared(block(fallback, '.dark'));
  const used = [...theme.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  assert.ok(used.length > 20);
  for (const [, name, value] of used) {
    for (const [, v] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      assert.ok(light.has(v), `${name}: var(${v}) not declared in :root`);
      if (name.startsWith('--color-')) assert.ok(dark.has(v), `${name}: var(${v}) not declared in .dark`);
    }
  }
});

// Invariant: index.css pulls in Tailwind, the animations, the fallback, and cc's class-based dark variant.
test('index.css imports and dark variant', () => {
  for (const imp of ['tailwindcss', 'tw-animate-css', './cc-theme-fallback.css']) {
    assert.match(indexCss, new RegExp(`@import ['"]${imp.replace(/[./]/g, '\\$&')}['"];`), imp);
  }
  assert.match(indexCss, /@custom-variant dark \(&:is\(\.dark \*\)\);/);
});

const own = sourceFiles().filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/') && n !== 'src/cc-theme-fallback.css');

// Invariant: the plugin's own code uses colours only through the theme tokens.
test('own code has no literal colours', () => {
  const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white';
  const literal = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(|\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|shadow|from|via|to|divide|accent|caret)-(?:${PALETTE})\\b`);
  assert.ok(own.length > 10);
  for (const [n, src] of own) assert.equal(literal.test(src), false, `${n}: ${src.match(literal)?.[0]}`);
});

// Invariant: only public/theme-init.js (standalone) touches the dark class or data-cc-theme, by any API
// (classList, className, setAttribute, dataset); cc's choice applies.
test("no theme control of the plugin's own", () => {
  const mutates = new RegExp([
    /classList\.(?:add|remove|toggle|replace)\(\s*['"]dark['"]/.source,
    /(?:set|remove|toggle)Attribute\(\s*['"]data-cc-theme/.source,
    /\.className\s*\+?=[^;\n]*\bdark\b/.source,
    /setAttribute\(\s*['"]class['"][^)\n]*\bdark\b/.source,
    /dataset\.ccTheme\s*=(?!=)/.source,
    /dataset\[\s*['"]ccTheme['"]\s*\]\s*=(?!=)/.source,
    /delete\s+[\w.]*dataset\.ccTheme/.source,
  ].join('|'));
  for (const bad of ["root.classList.add('dark')", "root.setAttribute('data-cc-theme', 'dark')", "root.className = 'dark'", "root.className += ' dark'",
    "root.setAttribute('class', 'x dark')", "root.dataset.ccTheme = 'light'", "root.dataset['ccTheme'] = 'light'", 'delete root.dataset.ccTheme']) {
    assert.ok(mutates.test(bad), `the scan catches ${bad}`);
  }
  for (const good of ['<div className="dark:bg-input/30">', "if (root.dataset.ccTheme === 'dark')", "el.className = 'darker-text'"]) {
    assert.equal(mutates.test(good), false, `the scan lets through ${good}`);
  }
  for (const [n, src] of sourceFiles()) {
    if (n === 'public/theme-init.js') {
      assert.match(src, /classList\.toggle\('dark'/);
      continue;
    }
    assert.equal(mutates.test(src), false, `${n}: ${src.match(mutates)?.[0]}`);
  }
});

const pane = read('src/components/SettingsPane.tsx');
const classLists = [...pane.matchAll(/className=(?:"([^"]*)"|\{[^}]*?'([^']*)'|\{(HINT)\})/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// Invariant: gap is the only source of Settings spacing; no margin or space-* utility returns.
test('Settings spacing: no margin or space-* utility in the pane', () => {
  assert.ok(classLists.length > 5);
  const MARGIN = /(?:^|[\s"'`:])-?(?:m[trblxyse]?|space-[xy])-[\w./[\]-]+/;
  assert.equal(MARGIN.test(pane), false, `SettingsPane.tsx: ${pane.match(MARGIN)?.[0]}`);
});

// Invariant: the pane body and every group stack their items as flex columns with a gap.
test('Settings spacing: every column in the pane is spaced by its gap', () => {
  const columns = [...pane.matchAll(/className="([^"]*\bflex-col\b[^"]*)"/g)].map((m) => m[1]);
  assert.ok(columns.length >= 4, 'the body and its three groups');
  for (const c of columns) assert.match(c, /\bgap-\d/, c);
});

// Invariant: a status line with no text adds no gap under its control.
test('Settings spacing: an empty status line takes no space', () => {
  const status = pane.match(/function StatusLine[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(status, /\bempty:hidden\b/);
});
