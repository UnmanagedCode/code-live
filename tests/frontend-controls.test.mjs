// Pins the session controls' view of every session state: the Connect button's
// label, disabled and aria-busy, the Pause button's label, disabled and
// aria-pressed, and which states lock the voice and instructions settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectButtonView, micButtonView, settingsLocked, isConnected } from '../frontend/src/lib/controls.js';

const STATES = ['idle', 'connecting', 'live', 'reconnecting', 'error'];

test('connect button: label, disabled, busy and variant per state', () => {
  const expected = {
    idle: { label: 'Connect', disabled: false, busy: false, variant: 'default' },
    connecting: { label: 'Connecting...', disabled: true, busy: true, variant: 'default' },
    live: { label: 'Disconnect', disabled: false, busy: false, variant: 'destructive' },
    reconnecting: { label: 'Disconnect', disabled: false, busy: false, variant: 'destructive' },
    error: { label: 'Connect', disabled: false, busy: false, variant: 'default' },
  };
  for (const state of STATES) assert.deepEqual(connectButtonView(state), expected[state], state);
});

test('mic button: enabled only while live or reconnecting', () => {
  for (const [state, enabled] of [['idle', false], ['connecting', false], ['live', true], ['reconnecting', true], ['error', false]]) {
    assert.equal(micButtonView(state, false).disabled, !enabled, state);
    assert.equal(micButtonView(state, true).disabled, !enabled, state);
  }
});

test('mic button: label and pressed follow the pause', () => {
  assert.deepEqual(micButtonView('live', false), { label: 'Pause mic', disabled: false, pressed: false });
  assert.deepEqual(micButtonView('live', true), { label: 'Resume mic', disabled: false, pressed: true });
});

test('settings lock while connecting, live and reconnecting only', () => {
  assert.deepEqual(STATES.filter(settingsLocked), ['connecting', 'live', 'reconnecting']);
  assert.deepEqual(STATES.filter(isConnected), ['live', 'reconnecting']);
});
