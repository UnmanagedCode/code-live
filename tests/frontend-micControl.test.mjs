// Pins: the Pause/Resume mic button is enabled only while a pause is meaningful
// (live or reconnecting), shows the session's pause state, and toggles it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';

async function build(state = 'live', micPaused = false) {
  const { document, installMicControl } = await loadDom('micControl.js');
  const button = document.createElement('button');
  const indicator = document.createElement('span');
  const calls = [];
  const session = { state, micPaused, pauseMic: () => calls.push('pause'), resumeMic: () => calls.push('resume') };
  const control = installMicControl({ button, indicator, session });
  return { button, indicator, calls, session, control };
}

test('the button is enabled only while live or reconnecting', async () => {
  for (const [state, enabled] of [['idle', false], ['connecting', false], ['live', true], ['reconnecting', true], ['error', false]]) {
    const { button, session, control } = await build('idle');
    session.state = state;
    control.render();
    assert.equal(button.disabled, !enabled, state);
  }
});

test('label, aria-pressed and the indicator follow micPaused', async () => {
  const { button, indicator, session, control } = await build();
  assert.equal(button.textContent, 'Pause mic');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(indicator.hidden, true);
  session.micPaused = true;
  control.render();
  assert.equal(button.textContent, 'Resume mic');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(indicator.hidden, false);
});

test('click calls pauseMic when unpaused and resumeMic when paused', async () => {
  const { button, session, calls } = await build();
  button.click();
  session.micPaused = true;
  button.click();
  assert.deepEqual(calls, ['pause', 'resume']);
});
