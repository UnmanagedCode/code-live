// Pins: the settings pane sends the key once, clears the input, shows only
// the masked tail, and never leaves the key anywhere in the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';
import { SENTINEL_KEY } from './helpers.mjs';

function fakeApi(initial = { set: false, tail: null }) {
  const calls = [];
  return {
    calls,
    getSettings: async () => ({ apiKey: initial }),
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
