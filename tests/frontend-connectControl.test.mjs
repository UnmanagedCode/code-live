// Pins: the single Connect / Disconnect button renders only from session.state
// (label, data-state, disabled and aria-busy) and its click starts or ends the
// session according to that state, never starting a second connect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';

async function build(state = 'idle') {
  const { document, installConnectControl } = await loadDom('connectControl.js');
  const button = document.createElement('button');
  const calls = [];
  const session = { state, disconnect: () => calls.push('disconnect') };
  const control = installConnectControl({ button, session, connect: () => calls.push('connect') });
  return { button, calls, session, control };
}

test('label, data-state, disabled and aria-busy follow session.state', async () => {
  const expected = [
    ['idle', 'Connect', false], ['connecting', 'Connecting...', true], ['live', 'Disconnect', false],
    ['reconnecting', 'Disconnect', false], ['error', 'Connect', false],
  ];
  for (const [state, text, busy] of expected) {
    const { button, session, control } = await build('idle');
    session.state = state;
    control.render();
    assert.equal(button.textContent, text, state);
    assert.equal(button.dataset.state, state);
    assert.equal(button.disabled, busy, state);
    assert.equal(button.getAttribute('aria-busy'), String(busy), state);
  }
});

test('click connects from idle or error and disconnects from live or reconnecting', async () => {
  for (const [state, call] of [['idle', 'connect'], ['error', 'connect'], ['live', 'disconnect'], ['reconnecting', 'disconnect']]) {
    const { button, calls } = await build(state);
    button.click();
    assert.deepEqual(calls, [call], state);
  }
});

test('a click while connecting does nothing even if the button is enabled', async () => {
  const { button, session, calls } = await build('idle');
  session.state = 'connecting'; // no render(): the button stays enabled
  button.click();
  assert.deepEqual(calls, []);
});
