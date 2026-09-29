// Pins: the frontend has no HTML-injection or code-eval sinks, no
// root-relative URLs (the page lives under the host's plugin prefix), and
// index.html references only existing local files with no inline code/style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const PUB = new URL('../public/', import.meta.url);
const jsFiles = readdirSync(PUB).filter((f) => f.endsWith('.js'));
const BANNED = [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\bsrcdoc\b/, /\beval\s*\(/, /new\s+Function\b/];

test('no HTML/eval sinks in public/*.js', () => {
  assert.ok(jsFiles.length >= 10);
  for (const f of jsFiles) {
    const src = readFileSync(new URL(f, PUB), 'utf8');
    for (const re of BANNED) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
});

test('no root-relative URLs in public/*.js', () => {
  for (const f of jsFiles) {
    const src = readFileSync(new URL(f, PUB), 'utf8');
    const hit = src.match(/['"`]\/(?!\/)/);
    assert.equal(hit, null, `${f} has a root-relative URL near ${hit && src.slice(hit.index, hit.index + 30)}`);
  }
});

test('index.html: relative, existing references and no inline code', () => {
  const html = readFileSync(new URL('index.html', PUB), 'utf8');
  const refs = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    assert.ok(!/^([a-z]+:|\/)/i.test(ref), `${ref} must be relative`);
    assert.ok(existsSync(new URL(ref, PUB)), `${ref} exists`);
  }
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.match(m[0], /\bsrc="/, 'scripts are external');
    assert.equal(m[1].trim(), '', 'no inline script body');
  }
  assert.ok(!/<style\b/i.test(html), 'no <style>');
  assert.ok(!/\sstyle=/i.test(html), 'no style=');
  assert.ok(!/\son[a-z]+=/i.test(html), 'no on*= handlers');
});
