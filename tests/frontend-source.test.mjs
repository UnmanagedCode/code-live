// Pins what the UI sources may contain: no HTML-injection, code-eval or
// raw-HTML sinks, no style/href/src built in the plugin's own code, no
// root-relative URL but the two host URLs (the page lives under the host's
// plugin prefix), no hash navigation, parent scripting or cc storage keys, and
// nothing that stops work when the page is hidden (cc keeps this page alive
// hidden). index.html loads the bridge first, then the host theme, then
// theme-init.js, with no inline code, and every reference it makes exists.
// No code creates a <style> element. main.tsx builds the one controller once,
// at module level before createRoot, never inside the rendered tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, sourceFiles, headAssets, HOST_URLS } from './frontendFiles.mjs';

const files = sourceFiles();
const code = files.filter(([n]) => /\.(ts|tsx|js)$/.test(n));
const own = code.filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/'));
const html = files.find(([n]) => n === 'index.html')[1];
const srcCode = code.filter(([n]) => n.startsWith('src/'));

// Each pattern's verdict on strings it must and must not match, so a scan cannot pass vacuously.
function assertPattern(re, bad, good) {
  for (const b of bad) assert.ok(re.test(b), `${re} catches ${b}`);
  for (const g of good) assert.equal(re.test(g), false, `${re} lets through ${g}`);
}

test('the scan sees the page code', () => {
  const names = files.map(([n]) => n);
  for (const n of ['index.html', 'public/theme-init.js', 'public/mic-worklet.js', 'src/main.tsx', 'src/App.tsx', 'src/components/Transcript.tsx',
    'src/components/SettingsPane.tsx', 'src/lib/controller.js', 'src/lib/announcements.js', 'src/lib/liveSession.js']) {
    assert.ok(names.includes(n), n);
  }
});

test('no HTML, eval or raw-HTML sinks, no hash navigation, no parent scripting, no cc storage keys', () => {
  const BANNED = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\bsrcdoc\b|\beval\s*\(|new\s+Function\b|dangerouslySetInnerHTML|setAttribute\(\s*['"]style|location\.hash\s*=|window\.parent|code-conductor:/;
  for (const [n, src] of files) assert.equal(BANNED.test(src), false, `${n}: ${src.match(BANNED)?.[0]}`);
});

test("the plugin's own code sets no style, href or src", () => {
  // Content reaches the DOM only as React text children; a URL in it shows as text.
  // An attribute in JSX or markup, a style object, or a CSSOM write (`el.style.x =`, `el.style[...]`).
  const ATTR = /\s(?:style|href|src)=["'{]|\bstyle:\s*\{|\.style(?:\.\w+)?\s*(?:=(?!=)|\[)/;
  assert.ok(own.length >= 10);
  for (const [n, src] of own) assert.equal(ATTR.test(src), false, `${n}: ${src.match(ATTR)?.[0]}`);
});

test('no code writes style, href or src through the DOM', () => {
  // setAttribute, a property assignment, or a CSSOM setProperty, in any page code (copied components included).
  const DOM_WRITE = /setAttribute\(\s*['"`](?:style|href|src)['"`]|\.(?:src|href)\s*=(?!=)|\.style\.setProperty\(/;
  assertPattern(DOM_WRITE,
    ["el.setAttribute('href', u)", 'el.setAttribute("src", u)', 'el.setAttribute(`style`, s)', 'img.src = url', 'a.href=url', "el.style.setProperty('color', c)"],
    ['src.buffer = buf', 'const src = ctx.createBufferSource()', 'a.src === b', 'el.setAttribute("aria-busy", "true")', "a.hrefLang = 'en'", 'audio.srcObject = stream']);
  assert.ok(srcCode.length >= 15);
  for (const [n, src] of srcCode) assert.equal(DOM_WRITE.test(src), false, `${n}: ${src.match(DOM_WRITE)?.[0]}`);
});

test('no code creates a <style> element', () => {
  const STYLE_EL = /createElement\(\s*['"`]style['"`]|<style[\s>/]/i;
  assertPattern(STYLE_EL, ["document.createElement('style')", 'document.createElement( "STYLE" )', '<style>{css}</style>', '<style jsx>', '<style/>'],
    ["document.createElement('div')", '<span data-style="x">', 'const styles = 1']);
  for (const [n, src] of srcCode) assert.equal(STYLE_EL.test(src), false, `${n}: ${src.match(STYLE_EL)?.[0]}`);
});

test('main.tsx builds exactly one controller, at module level, before createRoot', () => {
  const main = files.find(([n]) => n === 'src/main.tsx')[1];
  const calls = [...main.matchAll(/createAppController\(/g)];
  assert.equal(calls.length, 1, 'one controller');
  const decl = main.match(/^const (\w+) = createAppController\(\);$/m);
  assert.ok(decl, 'a top-level statement of its own, outside any function or JSX');
  const root = main.indexOf('createRoot(');
  assert.ok(root > decl.index, 'built before createRoot');
  assert.equal(main.slice(root).includes('createAppController'), false, 'not inside the rendered tree');
  assert.match(main.slice(root), new RegExp(`<App controller=\\{${decl[1]}\\} />`), 'the tree receives that one controller');
  for (const [n, src] of srcCode) if (n !== 'src/main.tsx') assert.equal(/createAppController\(/.test(src.replace(/export function createAppController\(/, '')), false, `${n} builds a controller`);
});

test('no root-relative URL in the page code', () => {
  for (const [n, src] of code) {
    const hit = src.match(/['"`]\/(?![/*])/);
    assert.equal(hit, null, `${n} has a root-relative URL near ${hit && src.slice(hit.index, hit.index + 30)}`);
  }
});

test('nothing stops when the page is hidden: no visibility or page-hide handling', () => {
  const HIDE = /visibilitychange|visibilityState|document\.hidden|pagehide|\bfreeze\b/;
  for (const [n, src] of code) assert.equal(HIDE.test(src), false, `${n}: ${src.match(HIDE)?.[0]}`);
});

test('index.html: host URLs first, then theme-init.js, no inline code, every other reference relative and existing', () => {
  assert.deepEqual(headAssets(html), [...HOST_URLS, 'theme-init.js', './src/main.tsx']);
  assert.match(html, /<script src="\/pluginBridge\.js" vite-ignore><\/script>/, 'the bridge is a blocking classic script');
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.match(m[0], /\bsrc="/, 'scripts are external');
    assert.equal(m[1].trim(), '', 'no inline script body');
  }
  assert.ok(!/<style\b/i.test(html), 'no <style>');
  assert.ok(!/\sstyle=/i.test(html), 'no style=');
  assert.ok(!/\son[a-z]+=/i.test(html), 'no on*= handlers');
  for (const ref of [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1])) {
    if (HOST_URLS.includes(ref)) continue;
    assert.ok(!/^([a-z]+:|\/)/i.test(ref), `${ref} must be relative`);
    const at = ref === 'theme-init.js' ? path.join(FRONTEND, 'public', ref) : path.join(FRONTEND, ref);
    assert.ok(existsSync(at), `${ref} exists`);
  }
});

test('no toasts, and components/ui holds only the copied components the page uses', () => {
  for (const [n, src] of code) assert.equal(/from ['"]sonner['"]/.test(src), false, `${n} imports sonner`);
  const ui = readdirSync(path.join(FRONTEND, 'src', 'components', 'ui')).sort();
  assert.deepEqual(ui, ['alert.tsx', 'badge.tsx', 'button.tsx', 'input.tsx', 'label.tsx', 'native-select.tsx', 'textarea.tsx']);
  for (const f of ui) {
    const name = f.replace('.tsx', '');
    assert.ok(own.some(([, src]) => src.includes(`@/components/ui/${name}'`)), `${f} is imported by the page`);
  }
});

test('the worklet stays a plain AudioWorklet file loaded by relative URL', () => {
  const worklet = files.find(([n]) => n === 'public/mic-worklet.js')[1];
  assert.match(worklet, /registerProcessor\('pcm-capture'/);
  assert.equal(/^\s*import\b/m.test(worklet), false, 'it is copied verbatim, so it imports nothing');
  const mic = files.find(([n]) => n === 'src/lib/micCapture.js')[1];
  assert.match(mic, /addModule\('mic-worklet\.js'\)/);
});
