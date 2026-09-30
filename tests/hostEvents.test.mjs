// Pins: the pure helpers behind announcing and reading: a trailing questions
// section survives truncation whole, a row shows a pending ask only for a
// tool-sourced question/plan, and a turn's msgId is scoped to that turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateBody, toolAsk, lastAssistantMsgId } from '../src/hostEvents.js';

const QUESTIONS = '--- questions ---\n1. Pick one (multiSelect: false) · header: Pick\n   - Alpha: first\n   - Beta: second';

test('truncateBody leaves short text alone and cuts long prose from the end', () => {
  assert.equal(truncateBody('short', 10), 'short');
  assert.equal(truncateBody('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
  assert.equal(truncateBody('', 10), '');
});

test('truncateBody keeps the trailing questions section whole and cuts the prose before it', () => {
  const body = `${'p'.repeat(500)}\n${QUESTIONS}`;
  const out = truncateBody(body, 200);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith(QUESTIONS));
  assert.match(out, /^p+…\n--- questions ---/, 'the fence stays at the start of a line');
});

test('truncateBody keeps only the questions when they leave no room for prose', () => {
  const out = truncateBody(`${'p'.repeat(500)}\n${QUESTIONS}`, QUESTIONS.length + 1);
  assert.equal(out, QUESTIONS);
});

test('truncateBody cuts a questions section that alone exceeds the limit, and cuts a plan normally', () => {
  assert.equal(truncateBody(QUESTIONS, 20), `${QUESTIONS.slice(0, 19)}…`);
  const plan = `intro\n--- plan ---\n${'s'.repeat(300)}`;
  assert.equal(truncateBody(plan, 100), `${plan.slice(0, 99)}…`);
});

test('toolAsk is set only for a tool-sourced question or plan', () => {
  assert.equal(toolAsk({ awaitingUser: 'question', awaitingUserSource: 'tool' }), 'question');
  assert.equal(toolAsk({ awaitingUser: 'plan', awaitingUserSource: 'tool' }), 'plan');
  assert.equal(toolAsk({ awaitingUser: 'question', awaitingUserSource: 'text' }), null);
  assert.equal(toolAsk({ awaitingUser: null, awaitingUserSource: null }), null);
  assert.equal(toolAsk({ awaitingUser: 'other', awaitingUserSource: 'tool' }), null);
  assert.equal(toolAsk(undefined), null);
});

test('lastAssistantMsgId is scoped to the turn ending at endSeq', () => {
  const events = [
    { _seq: 1, kind: 'assistant_message', msgId: 'a' },
    { _seq: 2, kind: 'turn_end' },
    { _seq: 3, kind: 'assistant_message', msgId: 'b' },
    { _seq: 4, kind: 'assistant_message', msgId: 'c' },
    { _seq: 5, kind: 'turn_end' },
    { _seq: 6, kind: 'assistant_message', msgId: 'd' },
    { _seq: 7, kind: 'turn_end' },
  ];
  assert.equal(lastAssistantMsgId(events, 2), 'a');
  assert.equal(lastAssistantMsgId(events, 5), 'c');
  assert.equal(lastAssistantMsgId(events, 7), 'd');
  assert.equal(lastAssistantMsgId([{ _seq: 1, kind: 'assistant_message', msgId: 'a' }, { _seq: 2, kind: 'turn_end' }, { _seq: 3, kind: 'turn_end' }], 3), null, 'a turn that said nothing has no msgId');
  assert.equal(lastAssistantMsgId([{ _seq: 1, kind: 'assistant_message' }, { _seq: 2, kind: 'turn_end' }], 2), null, 'an event without a msgId gives none');
});
