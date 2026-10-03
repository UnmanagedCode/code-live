// Pins: the settings pane sends the key once, clears the input, shows only
// the masked tail, and never leaves the key anywhere in the DOM. It also pins
// the voice select and custom-instructions textarea: loaded from the backend,
// saved through the api, stored text rendered only as text, and locked on request.
// The structure behind the spacing rhythm: every control sits in a group, and
// only the closing note sits outside one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';
import { SENTINEL_KEY } from './helpers.mjs';

const VOICES = [{ name: 'Puck', style: 'Upbeat' }, { name: 'Kore', style: 'Firm' }];

function fakeApi(initial = { set: false, tail: null }, { voice = null, customPrompt = '', customPromptMax = 4000 } = {}) {
  const calls = [];
  return {
    calls,
    getSettings: async () => ({ apiKey: initial, voice, customPrompt, customPromptMax }),
    getVoices: async () => ({ voices: VOICES }),
    setVoice: async (v) => { calls.push(['voice', v]); return { voice: v, customPrompt }; },
    setCustomPrompt: async (text) => { calls.push(['prompt', text]); return { voice, customPrompt: text.trim() }; },
    setApiKey: async (k) => { calls.push(['set', k]); return { apiKey: { set: true, tail: k.slice(-4) } }; },
    clearApiKey: async () => { calls.push(['clear']); return { apiKey: { set: false, tail: null } }; },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function domContains(root, needle) {
  if (root.textContent.includes(needle)) return true;
  return [...root.querySelectorAll('*')].some((n) => (n.value ?? '').includes(needle) || [...n.attributes].some((a) => a.value.includes(needle)));
}

test('save sends the key, clears the input and shows only the tail', async () => {
  const { document, installSettings } = await loadDom('settings.js');
  const root = document.createElement('div');
  const api = fakeApi();
  await installSettings(root, api).ready;
  const input = root.querySelector('input');
  assert.equal(input.type, 'password');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.equal(root.querySelector('.settings-status').textContent, 'No key set');
  input.value = SENTINEL_KEY;
  root.querySelectorAll('button')[0].click();
  await flush();
  assert.deepEqual(api.calls, [['set', SENTINEL_KEY]]);
  assert.equal(input.value, '');
  assert.equal(root.querySelector('.settings-status').textContent, 'Key set (••••cdef)');
  assert.equal(domContains(root, SENTINEL_KEY.slice(0, 12)), false);

  root.querySelectorAll('button')[1].click();
  await flush();
  assert.deepEqual(api.calls.at(-1), ['clear']);
  assert.equal(root.querySelector('.settings-status').textContent, 'No key set');
});

test('errors render as text', async () => {
  const { document, installSettings } = await loadDom('settings.js');
  const root = document.createElement('div');
  const api = { ...fakeApi({ set: true, tail: 'wxyz' }), setApiKey: async () => { throw new Error('<img src=x onerror=alert(1)> bad'); } };
  await installSettings(root, api).ready;
  assert.equal(root.querySelector('.settings-status').textContent, 'Key set (••••wxyz)');
  root.querySelector('input').value = 'whatever-key-value-123';
  root.querySelectorAll('button')[0].click();
  await flush();
  assert.equal(root.querySelector('.settings-status').textContent, '<img src=x onerror=alert(1)> bad');
  assert.equal(root.querySelectorAll('img').length, 0);
});

async function mount(api) {
  const { document, installSettings } = await loadDom('settings.js');
  const root = document.createElement('div');
  const settings = installSettings(root, api);
  await settings.ready;
  return { root, settings, voice: root.querySelector('#settings-voice'), prompt: root.querySelector('#settings-prompt'), save: root.querySelector('#settings-prompt-save') };
}

const change = (select, value) => { select.value = value; select.dispatchEvent(new window.Event('change')); };

test('load: Default then the catalog, with the stored voice, prompt and maxlength', async () => {
  const { voice, prompt } = await mount(fakeApi(undefined, { voice: 'Kore', customPrompt: 'Be brief.', customPromptMax: 123 }));
  assert.deepEqual([...voice.options].map((o) => [o.value, o.textContent]), [['', "Default (model's choice)"], ['Puck', 'Puck (Upbeat)'], ['Kore', 'Kore (Firm)']]);
  assert.equal(voice.value, 'Kore');
  assert.equal(prompt.value, 'Be brief.');
  assert.equal(prompt.getAttribute('maxlength'), '123');
});

test('load: no stored voice selects Default', async () => {
  const { voice } = await mount(fakeApi());
  assert.equal(voice.value, '');
});

test('changing the voice saves it, and Default saves null', async () => {
  const api = fakeApi();
  const { root, voice } = await mount(api);
  change(voice, 'Puck');
  await flush();
  assert.deepEqual(api.calls, [['voice', 'Puck']]);
  assert.equal(root.querySelector('.voice-status').textContent, 'Saved: Puck. Applies on the next Connect.');
  change(voice, '');
  await flush();
  assert.deepEqual(api.calls.at(-1), ['voice', null]);
  assert.equal(voice.value, '');
  assert.equal(root.querySelector('.voice-status').textContent, 'Saved: default voice. Applies on the next Connect.');
});

test('a failed voice save restores the previous selection and shows the error as text', async () => {
  const api = { ...fakeApi(undefined, { voice: 'Kore' }), setVoice: async () => { throw new Error('<img src=x onerror=alert(1)> nope'); } };
  const { root, voice } = await mount(api);
  change(voice, 'Puck');
  await flush();
  assert.equal(voice.value, 'Kore');
  const status = root.querySelector('.voice-status');
  assert.equal(status.textContent, '<img src=x onerror=alert(1)> nope');
  assert.ok(status.classList.contains('error'));
  assert.equal(root.querySelectorAll('img').length, 0);
});

test('Save sends the textarea value, shows the normalized reply, and says Cleared for empty text', async () => {
  const api = fakeApi();
  const { root, prompt, save } = await mount(api);
  prompt.value = '  Be brief.  ';
  save.click();
  await flush();
  assert.deepEqual(api.calls, [['prompt', '  Be brief.  ']]);
  assert.equal(prompt.value, 'Be brief.');
  assert.equal(root.querySelector('.prompt-status').textContent, 'Saved. Applies on the next Connect.');
  prompt.value = '   ';
  save.click();
  await flush();
  assert.equal(prompt.value, '');
  assert.equal(root.querySelector('.prompt-status').textContent, 'Cleared. Applies on the next Connect.');
});

test('a failed prompt save keeps the draft and shows the error', async () => {
  const api = { ...fakeApi(), setCustomPrompt: async () => { throw new Error('too long'); } };
  const { root, prompt, save } = await mount(api);
  prompt.value = 'my draft';
  save.click();
  await flush();
  assert.equal(prompt.value, 'my draft');
  assert.equal(root.querySelector('.prompt-status').textContent, 'too long');
  assert.ok(root.querySelector('.prompt-status').classList.contains('error'));
});

test('a stored prompt with markup stays text', async () => {
  const { root, prompt } = await mount(fakeApi(undefined, { customPrompt: '<img src=x onerror=alert(1)>' }));
  assert.equal(prompt.value, '<img src=x onerror=alert(1)>');
  assert.equal(root.querySelectorAll('img').length, 0);
});

test('setLocked disables the voice, prompt and its Save, never the key controls', async () => {
  const { root, settings, voice, prompt, save } = await mount(fakeApi());
  const keyControls = [root.querySelector('input'), ...[...root.querySelectorAll('button')].filter((b) => b !== save)];
  settings.setLocked(true);
  for (const c of [voice, prompt, save]) assert.equal(c.disabled, true);
  for (const c of keyControls) assert.equal(c.disabled, false);
  settings.setLocked(false);
  for (const c of [voice, prompt, save]) assert.equal(c.disabled, false);
});

// Invariant: every control, row, label and status is inside a group that is a direct child of root.
test('every settings control, row and status sits in a settings group', async () => {
  const { root } = await mount(fakeApi());
  const items = [...root.querySelectorAll('input, select, textarea, .row, .settings-status, label')];
  assert.ok(items.length > 0);
  for (const item of items) {
    const group = item.closest('.settings-group');
    assert.ok(group, `${item.tagName}.${item.className} is outside a settings group`);
    assert.equal(group.parentElement, root);
  }
});

// Invariant: the one ungrouped child of root is the closing hint, last.
test('the only element outside a group is the footer note', async () => {
  const { root } = await mount(fakeApi());
  const outside = [...root.children].filter((c) => !c.classList.contains('settings-group'));
  assert.equal(outside.length, 1);
  assert.equal(outside[0].tagName, 'P');
  assert.ok(outside[0].classList.contains('hint'));
  assert.equal(root.lastElementChild, outside[0]);
});
