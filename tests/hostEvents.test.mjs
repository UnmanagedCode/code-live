// Pins: the pure helpers behind announcing and reading: a trailing questions
// section survives truncation whole, a row shows a pending ask only for a
// tool-sourced question/plan, and a turn's msgId is scoped to that turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateBody, toolAsk, lastAssistantMsgId, assistantText, newestTurnEnd, latestAskEvent, askTurnEnd, askId, renderQuestions, renderPlan } from '../src/hostEvents.js';

const QUESTIONS = '--- questions ---\n1. Pick one (multiSelect: false) · header: Pick\n   - Alpha: first\n   - Beta: second';

test('truncateBody leaves short text alone and cuts long prose from the end', () => {
  assert.deepEqual(truncateBody('short', 10), { text: 'short', cut: false });
  assert.deepEqual(truncateBody('x'.repeat(50), 10), { text: `${'x'.repeat(9)}…`, cut: false });
  assert.deepEqual(truncateBody('', 10), { text: '', cut: false });
});

test('truncateBody keeps the trailing questions section whole and cuts the prose before it', () => {
  const body = `${'p'.repeat(500)}\n${QUESTIONS}`;
  const { text, cut } = truncateBody(body, 200);
  assert.ok(text.length <= 200);
  assert.ok(text.endsWith(QUESTIONS));
  assert.match(text, /^p+…\n--- questions ---/, 'the fence stays at the start of a line');
  assert.equal(cut, false, 'nothing of the questions was lost');
});

test('truncateBody keeps only the questions when they leave no room for prose', () => {
  assert.deepEqual(truncateBody(`${'p'.repeat(500)}\n${QUESTIONS}`, QUESTIONS.length + 1), { text: QUESTIONS, cut: false });
});

test('truncateBody cuts a plan from the end', () => {
  const plan = `intro\n--- plan ---\n${'s'.repeat(300)}`;
  assert.deepEqual(truncateBody(plan, 100), { text: `${plan.slice(0, 99)}…`, cut: false });
});

// Ten questions of six options, each with a long description.
const bigQuestions = Array.from({ length: 10 }, (_, q) => ({
  question: `Question ${q + 1}?`,
  header: `H${q + 1}`,
  multiSelect: false,
  options: Array.from({ length: 6 }, (_, o) => ({ label: `Q${q + 1}-Option-${o + 1}`, description: 'long description '.repeat(12) })),
}));

test('an oversized questions section is shortened within, descriptions before labels, and flagged', () => {
  const full = renderQuestions(bigQuestions);
  assert.ok(full.length > 4000, 'the fixture exceeds the limit');
  const { text, cut } = truncateBody(`Prose first.\n${full}`, 4000);
  assert.equal(cut, true);
  assert.ok(text.length <= 4000);
  assert.ok(text.startsWith('--- questions ---'), 'the prose made room for the section');
  for (let q = 1; q <= 10; q++) {
    assert.ok(text.includes(`${q}. Question ${q}?`), `question ${q} survives`);
    for (let o = 1; o <= 6; o++) assert.ok(text.includes(`Q${q}-Option-${o}`), `label Q${q}-Option-${o} survives`);
  }
  assert.ok(text.includes('…'), 'descriptions were cut');
});

test('a questions section too big even for bare labels loses trailing lines and is flagged', () => {
  const many = [{ question: 'Q?', multiSelect: false, options: Array.from({ length: 400 }, (_, i) => ({ label: `Option number ${i}`, description: '' })) }];
  const { text, cut } = truncateBody(renderQuestions(many), 1000);
  assert.equal(cut, true);
  assert.ok(text.length <= 1000);
});

test('renderQuestions and renderPlan follow the host body format', () => {
  assert.equal(renderQuestions([{ question: 'Pick?', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }]),
    '--- questions ---\n1. Pick? (multiSelect: true) · header: H\n   - A: first\n   - B');
  assert.equal(renderPlan({ plan: 'Do it', planPath: '/p.md' }), '--- plan · saved to /p.md ---\nDo it');
  assert.equal(renderPlan({ plan: 'Do it', planPath: null }), '--- plan ---\nDo it');
  assert.equal(renderPlan({ plan: null, planPath: '/p.md' }), '--- plan · saved to /p.md ---');
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

const say = (seq, msgId, text, extra = {}) => ({ _seq: seq, kind: 'assistant_message', msgId, message: { content: [{ type: 'text', text }] }, ...extra });

test('sub-agent events (parentToolUseId) are not the conductor\'s turn: msgId, text and turn_end all skip them', () => {
  const events = [
    say(1, 'main', 'conductor speaking'),
    say(2, 'sub', 'sub-agent chatter', { parentToolUseId: 'toolu_1' }),
    { _seq: 3, kind: 'turn_end', parentToolUseId: 'toolu_1' },
    { _seq: 4, kind: 'turn_end' },
  ];
  assert.equal(lastAssistantMsgId(events, 4), 'main', 'the sub-agent message does not become the turn\'s msgId');
  assert.equal(assistantText(events[1]), '');
  assert.equal(assistantText(events[0]), 'conductor speaking');
  assert.equal(newestTurnEnd(events, -1)._seq, 4);
  assert.equal(newestTurnEnd(events.slice(0, 3), -1), null, 'a sub-agent turn_end alone is no turn');
});

test('latestAskEvent picks the newest top-level, non-auto-approved ask of the kind', () => {
  const q = (seq, extra = {}) => ({ _seq: seq, kind: 'user_question', toolUseId: `q${seq}`, questions: [{ question: 'x', options: [] }], ...extra });
  const plan = (seq, extra = {}) => ({ _seq: seq, kind: 'plan_request', toolUseId: `p${seq}`, plan: 'p', ...extra });
  assert.equal(latestAskEvent([q(1), q(3), q(5, { parentToolUseId: 't' })], 'question')._seq, 3);
  assert.equal(latestAskEvent([q(1, { questions: 'nope' })], 'question'), null);
  assert.equal(latestAskEvent([plan(1), plan(2, { autoApproved: true })], 'plan')._seq, 1);
  assert.equal(latestAskEvent([q(1)], 'plan'), null);
});

test('askTurnEnd is the first top-level turn_end after the ask; askId survives renumbering', () => {
  const ask = { _seq: 2, kind: 'user_question', toolUseId: 'tu-9' };
  const events = [ask, { _seq: 3, kind: 'turn_end', parentToolUseId: 'x' }, { _seq: 4, kind: 'turn_end' }, { _seq: 6, kind: 'turn_end' }];
  assert.equal(askTurnEnd(events, ask)._seq, 4);
  assert.equal(askTurnEnd(events.slice(0, 2), ask), null, 'the ask\'s turn is still running');
  assert.equal(askId(ask), 'tu-9');
  assert.equal(askId({ ...ask, _seq: 40 }), 'tu-9');
  assert.equal(askId({ kind: 'user_question', _seq: 7 }), 'user_question@7', 'without a tool_use id the position stands in');
});
