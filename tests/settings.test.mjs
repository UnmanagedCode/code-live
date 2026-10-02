// Pins: the voice and custom-instructions routes — defaults, save-then-read,
// 400 codes for bad input, 415 for a non-JSON body — and that both survive a
// backend restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { VOICES } from '../src/voices.js';
import { CUSTOM_PROMPT_MAX } from '../src/prefsStore.js';
import { startApp, req } from './helpers.mjs';

const put = (app, path, body) => req(`${app.url}/api/settings/${path}`, { method: 'PUT', body });

test('GET /api/voices is the catalog', async (t) => {
  const app = await startApp({ startLink: false });
  t.after(() => app.stop());
  assert.deepEqual((await req(`${app.url}/api/voices`)).json, { voices: VOICES });
});

test('GET /api/settings defaults, and each PUT is reflected', async (t) => {
  const app = await startApp({ startLink: false });
  t.after(() => app.stop());
  const get = async () => (await req(`${app.url}/api/settings`)).json;
  assert.deepEqual(await get(), { apiKey: { set: false, tail: null }, voice: null, customPrompt: '', customPromptMax: CUSTOM_PROMPT_MAX });

  let r = await put(app, 'voice', { voice: 'Puck' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { voice: 'Puck', customPrompt: '' });
  r = await put(app, 'custom-prompt', { customPrompt: '  Be brief.\r\n' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { voice: 'Puck', customPrompt: 'Be brief.' });
  assert.deepEqual(await get(), { apiKey: { set: false, tail: null }, voice: 'Puck', customPrompt: 'Be brief.', customPromptMax: CUSTOM_PROMPT_MAX });

  r = await put(app, 'voice', { voice: null });
  assert.deepEqual(r.json, { voice: null, customPrompt: 'Be brief.' });
});

test('bad input is a 400 with its code; a non-JSON body is a 415', async (t) => {
  const app = await startApp({ startLink: false });
  t.after(() => app.stop());
  let r = await put(app, 'voice', { voice: 'puck' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'UNKNOWN_VOICE');
  r = await put(app, 'voice', {});
  assert.equal(r.json.code, 'UNKNOWN_VOICE', 'a missing voice is not the default');
  r = await put(app, 'custom-prompt', { customPrompt: 'a'.repeat(CUSTOM_PROMPT_MAX + 1) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID_PROMPT');
  r = await put(app, 'custom-prompt', { customPrompt: 5 });
  assert.equal(r.json.code, 'INVALID_PROMPT');
  for (const path of ['voice', 'custom-prompt']) {
    r = await req(`${app.url}/api/settings/${path}`, { method: 'PUT', raw: 'x', headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415, path);
  }
  assert.deepEqual((await req(`${app.url}/api/settings`)).json.voice, null);
});

test('both survive a restart', async (t) => {
  const first = await startApp({ startLink: false });
  let second;
  t.after(async () => { await second?.stop(); await fs.rm(first.root, { recursive: true, force: true }); });
  await put(first, 'voice', { voice: 'Kore' });
  await put(first, 'custom-prompt', { customPrompt: 'Be brief.' });
  await first.stop({ keepRoot: true });
  second = await startApp({ projectsRoot: first.root, startLink: false });
  const r = await req(`${second.url}/api/settings`);
  assert.equal(r.json.voice, 'Kore');
  assert.equal(r.json.customPrompt, 'Be brief.');
});
