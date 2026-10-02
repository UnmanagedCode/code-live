// Pins: preferences.json lives at <PROJECTS_ROOT>/.code-live/, is 0600 and
// written atomically; defaults when absent; the voice and prompt are
// validated before anything is written; a malformed file fails loudly; and
// concurrent setters both land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPrefsStore, CUSTOM_PROMPT_MAX } from '../src/prefsStore.js';
import { tempDir, waitFor } from './helpers.mjs';

async function setup(t, opts = {}) {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.code-live');
  return { dir, store: createPrefsStore({ dir, ...opts }) };
}

const DEFAULTS = { voice: null, customPrompt: '' };

test('defaults when absent; set values round-trip at the path, 0600, no temp file, and survive a restart', async (t) => {
  const { dir, store } = await setup(t);
  assert.deepEqual(await store.get(), DEFAULTS);
  assert.deepEqual(await store.setVoice('Kore'), { voice: 'Kore', customPrompt: '' });
  assert.deepEqual(await store.setCustomPrompt('Be brief.'), { voice: 'Kore', customPrompt: 'Be brief.' });
  assert.equal(store.file, path.join(dir, 'preferences.json'));
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
  assert.deepEqual(await createPrefsStore({ dir }).get(), { voice: 'Kore', customPrompt: 'Be brief.' });
});

test('an unknown voice is rejected and the file is untouched; null clears', async (t) => {
  const { store } = await setup(t);
  await store.setVoice('Kore');
  const before = await fs.readFile(store.file, 'utf8');
  for (const bad of ['kore', 'Nope', 42, undefined]) {
    await assert.rejects(store.setVoice(bad), { code: 'UNKNOWN_VOICE' }, String(bad));
  }
  assert.equal(await fs.readFile(store.file, 'utf8'), before);
  assert.deepEqual(await store.setVoice(null), DEFAULTS);
});

test('prompt validation: bound, type, control characters and normalization', async (t) => {
  const { store } = await setup(t);
  const max = 'a'.repeat(CUSTOM_PROMPT_MAX);
  assert.equal((await store.setCustomPrompt(max)).customPrompt, max);
  await assert.rejects(store.setCustomPrompt(max + 'a'), { code: 'INVALID_PROMPT', message: `custom instructions must be at most ${CUSTOM_PROMPT_MAX} characters` });
  await assert.rejects(store.setCustomPrompt(7), { code: 'INVALID_PROMPT', message: 'customPrompt must be a string' });
  await assert.rejects(store.setCustomPrompt('a\u0007b'), { code: 'INVALID_PROMPT', message: 'custom instructions may not contain control characters' });
  await assert.rejects(store.setCustomPrompt('a\u007fb'), { code: 'INVALID_PROMPT' });
  assert.equal((await store.get()).customPrompt, max, 'rejected input left the stored prompt');
  assert.equal((await store.setCustomPrompt('  a\r\nb\rc\t  ')).customPrompt, 'a\nb\nc');
  assert.equal((await store.setCustomPrompt(' \n\t ')).customPrompt, '');
});

test('the length bound applies after trimming', async (t) => {
  const { store } = await setup(t);
  const max = 'a'.repeat(CUSTOM_PROMPT_MAX);
  assert.equal((await store.setCustomPrompt(`  ${max}\r\n`)).customPrompt, max);
});

test('a malformed file is STORE_CORRUPT', async (t) => {
  const { dir, store } = await setup(t);
  await fs.mkdir(dir, { recursive: true });
  const bad = [
    '{not json', '[]', '"x"',
    JSON.stringify({ voice: 5 }), JSON.stringify({ voice: 'Nope' }), JSON.stringify({ voice: 'kore' }),
    JSON.stringify({ customPrompt: 7 }), JSON.stringify({ customPrompt: 'a'.repeat(CUSTOM_PROMPT_MAX + 1) }),
    JSON.stringify({ customPrompt: 'a\u0007' }),
  ];
  for (const raw of bad) {
    await fs.writeFile(store.file, raw);
    await assert.rejects(store.get(), { code: 'STORE_CORRUPT' }, raw);
    await assert.rejects(store.setVoice('Kore'), { code: 'STORE_CORRUPT' }, raw);
  }
});

test('missing fields default individually', async (t) => {
  const { dir, store } = await setup(t);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(store.file, JSON.stringify({ voice: 'Puck' }));
  assert.deepEqual(await store.get(), { voice: 'Puck', customPrompt: '' });
  await fs.writeFile(store.file, JSON.stringify({ customPrompt: 'x' }));
  assert.deepEqual(await store.get(), { voice: null, customPrompt: 'x' });
});

test('concurrent setVoice and setCustomPrompt both land: the second read-merge-write waits for the first write', async (t) => {
  const gates = [];
  // Each write completes only when the test releases it.
  const write = (file, data) => new Promise((resolve) => gates.push(async () => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); resolve(); }));
  const { store } = await setup(t, { write });
  const a = store.setVoice('Puck');
  const b = store.setCustomPrompt('Be brief.');
  await waitFor(() => gates.length === 1, { what: 'the first write' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gates.length, 1, 'the second write has not started while the first is pending');
  await gates.shift()();
  await a;
  await waitFor(() => gates.length === 1, { what: 'the second write' });
  await gates.shift()();
  assert.deepEqual(await b, { voice: 'Puck', customPrompt: 'Be brief.' });
  assert.deepEqual(await store.get(), { voice: 'Puck', customPrompt: 'Be brief.' });
});
