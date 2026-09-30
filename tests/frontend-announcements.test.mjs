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
  const { document, installAnnouncements, createTranscript, ANNOUNCE_PREFIX, ASK_QUESTION_MARK, ASK_PLAN_MARK } = await loadDom('announcements.js', 'transcript.js');
  const root = document.createElement('div');
  const transcript = createTranscript(root);
  const es = fakeEventSource();
  const sent = [];
  const targets = [];
  const hosts = [];
  const session = { state, sendText: (t) => sent.push(t) };
  installAnnouncements({ eventSource: es, transcript, session, targetPicker: { update: (t) => targets.push(t) }, hostIndicator: { set: (c) => hosts.push(c) } });
  return { root, es, sent, targets, hosts, session, ANNOUNCE_PREFIX, ASK_QUESTION_MARK, ASK_PLAN_MARK };
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

test('a question announce ends with the AWAITING ANSWER line and labels the transcript entry', async () => {
  const { root, es, sent, ASK_QUESTION_MARK } = await setup('live');
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'Q\n--- questions ---\n1. Which?', turnSeq: 3, isError: false, ask: { kind: 'question', count: 2 } });
  assert.deepEqual(sent, ['CONDUCTOR UPDATE from "Alpha":\nQ\n--- questions ---\n1. Which?\nAWAITING ANSWER: 2 question(s). Use answer_conductor_question.']);
  assert.ok(sent[0].includes(ASK_QUESTION_MARK));
  assert.equal(root.querySelector('.entry-label').textContent, 'Conductor · Alpha · question');
  assert.equal(root.querySelector('.entry-body').textContent, 'Q\n--- questions ---\n1. Which?', 'the transcript body has no footer');
});

test('a plan announce ends with the AWAITING PLAN APPROVAL line, with the plan file when known', async () => {
  const { root, es, sent, ASK_PLAN_MARK } = await setup('live');
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'plan text', ask: { kind: 'plan', planPath: '/plans/p.md' } });
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'inline plan', ask: { kind: 'plan', planPath: null } });
  assert.deepEqual(sent, [
    'CONDUCTOR UPDATE from "Alpha":\nplan text\nAWAITING PLAN APPROVAL (plan file: /plans/p.md).',
    'CONDUCTOR UPDATE from "Alpha":\ninline plan\nAWAITING PLAN APPROVAL.',
  ]);
  assert.ok(sent.every((s) => s.includes(ASK_PLAN_MARK)));
  assert.deepEqual([...root.querySelectorAll('.entry-label')].map((n) => n.textContent), ['Conductor · Alpha · plan', 'Conductor · Alpha · plan']);
});

test('an announce without an ask has no footer and no label suffix', async () => {
  for (const ask of [undefined, null]) {
    const { root, es, sent } = await setup('live');
    es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'done', ask });
    assert.deepEqual(sent, ['CONDUCTOR UPDATE from "Alpha":\ndone']);
    assert.equal(root.querySelector('.entry-label').textContent, 'Conductor · Alpha');
  }
});

test('the system prompt keys on both ask marks and on the approval confirmation', () => {
  assert.ok(SYSTEM_PROMPT.includes('"AWAITING ANSWER"'));
  assert.ok(SYSTEM_PROMPT.includes('"AWAITING PLAN APPROVAL"'));
  assert.match(SYSTEM_PROMPT, /answer_conductor_question/);
  assert.match(SYSTEM_PROMPT, /without permission prompts.*explicit yes.*confirmed true/s);
  assert.match(SYSTEM_PROMPT, /INVALID_OPTION/);
});

test('hostile plan, question and title text renders as text, never as elements', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const { root, es, sent } = await setup('live');
  es.emit('announce', { sessionId: 'c', title: evil, text: `plan ${evil}`, ask: { kind: 'plan', planPath: evil } });
  es.emit('announce', { sessionId: 'c', title: evil, text: `--- questions ---\n1. ${evil}`, ask: { kind: 'question', count: 1 } });
  assert.equal(root.querySelectorAll('img,script').length, 0);
  assert.equal(root.querySelectorAll('.entry').length, 2);
  assert.ok(root.textContent.includes(evil));
  assert.equal(sent.length, 2);
});

test('a question announce whose options were shortened says so in its final line', async () => {
  const { es, sent } = await setup('live');
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'Q', ask: { kind: 'question', count: 10, truncated: true } });
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'Q', ask: { kind: 'question', count: 10 } });
  assert.match(sent[0], /AWAITING ANSWER: 10 question\(s\)\. Use answer_conductor_question\. Some options above were shortened: say so, and let the user pick by option number\.$/);
  assert.match(sent[1], /answer_conductor_question\.$/, 'an untruncated ask has no note');
});

test('a question announce with dropped options says options are missing, not merely shortened', async () => {
  const { es, sent } = await setup('live');
  es.emit('announce', { sessionId: 'c', title: 'Alpha', text: 'Q', ask: { kind: 'question', count: 1, truncated: true, dropped: true } });
  assert.match(sent[0], /answer_conductor_question\. Some options are missing from the text above: say so, and let the user pick by option number\.$/);
  assert.doesNotMatch(sent[0], /shortened/);
});
