// Pins: an SSE `announce` lands in the transcript and, only while the Gemini
// session is live, is injected with the CONDUCTOR UPDATE prefix the system
// prompt keys on; `target` and `host` events update their widgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';
import { SYSTEM_PROMPT } from '../src/liveSetup.js';

function fakeEventSource() {
  const listeners = {};
  return {
    addEventListener: (name, fn) => { (listeners[name] ??= []).push(fn); },
    emit: (name, data) => { for (const fn of listeners[name] ?? []) fn({ data: JSON.stringify(data) }); },
  };
}

async function setup(state) {
  const { document, installAnnouncements, createTranscript, ANNOUNCE_PREFIX } = await loadDom('announcements.js', 'transcript.js');
  const root = document.createElement('div');
  const transcript = createTranscript(root);
  const es = fakeEventSource();
  const sent = [];
  const targets = [];
  const hosts = [];
  const session = { state, sendText: (t) => sent.push(t) };
  installAnnouncements({ eventSource: es, transcript, session, targetPicker: { update: (t) => targets.push(t) }, hostIndicator: { set: (c) => hosts.push(c) } });
  return { root, es, sent, targets, hosts, session, ANNOUNCE_PREFIX };
}

test('announce while live: transcript entry plus injected update', async () => {
  const { root, es, sent, ANNOUNCE_PREFIX } = await setup('live');
  assert.ok(SYSTEM_PROMPT.includes(`"${ANNOUNCE_PREFIX}"`), 'the prefix matches the system prompt');
  es.emit('announce', { sessionId: 'c', title: 'Alpha <b>plan</b>', text: 'All <i>done</i>', turnSeq: 3, isError: false });
  assert.deepEqual(sent, ['CONDUCTOR UPDATE from "Alpha <b>plan</b>":\nAll <i>done</i>']);
  const entry = root.querySelector('.entry-conductor');
  assert.equal(entry.querySelector('.entry-body').textContent, 'All <i>done</i>');
  assert.match(entry.querySelector('.entry-label').textContent, /Alpha <b>plan<\/b>/);
  assert.equal(root.querySelectorAll('b,i').length, 0);
});

test('announce while not live: transcript only', async () => {
  for (const state of ['idle', 'connecting', 'reconnecting', 'error']) {
    const { root, es, sent } = await setup(state);
    es.emit('announce', { sessionId: 'c', title: 't', text: 'x' });
    assert.deepEqual(sent, []);
    assert.equal(root.querySelectorAll('.entry-conductor').length, 1);
  }
});

test('target and host events update their widgets', async () => {
  const { es, targets, hosts } = await setup('idle');
  es.emit('target', { sessionId: 'c', title: 't' });
  es.emit('target', null);
  es.emit('host', { connected: true });
  es.emit('host', { connected: false });
  assert.deepEqual(targets, [{ sessionId: 'c', title: 't' }, null]);
  assert.deepEqual(hosts, [true, false]);
});
