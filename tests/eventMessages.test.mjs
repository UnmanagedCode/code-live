// Pins: the messages rebuilt from the host's events match what the host's own
// reconstruction yields: the same prose from envelopes or from disk-replayed
// deltas, plans and questions attached to their own message, narration kept
// apart, a sub-agent never mixed in, and the default selection bonded within
// one turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleMessages, bondedSelection, messageBody, parseMessageKey, wholeMessages } from '../src/eventMessages.js';

const seq = (events) => events.map((ev, i) => (ev._seq === undefined ? { ...ev, _seq: i + 1 } : ev));
const envelope = (msgId, blocks, extra = {}) => ({ kind: 'assistant_message', msgId, message: { content: blocks }, ...extra });
const textBlock = (text) => ({ type: 'text', text });
const delta = (msgId, blockIdx, text, extra = {}) => ({ kind: 'text_delta', msgId, blockIdx, text, ...extra });
const QUESTIONS = [{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A', description: 'first' }] }];

// Invariant: a message streamed as per-block envelopes and the same message replayed from disk as deltas only
// assemble to identical prose, joined with '' as the host joins it.
test('envelope and delta forms assemble the same prose', () => {
  const live = assembleMessages(seq([
    { kind: 'message_start', msgId: 'm1' },
    envelope('m1', [textBlock('First block. ')], { blockIdx: 0 }),
    envelope('m1', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], { blockIdx: 1 }),
    envelope('m1', [textBlock('Second block.')], { blockIdx: 2 }),
  ]));
  const replayed = assembleMessages(seq([
    delta('m1', 0, 'First '), delta('m1', 0, 'block. '),
    { kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 't', name: 'Bash', input: {} },
    delta('m1', 2, 'Second block.'),
  ]));
  assert.equal(live[0].prose, 'First block. Second block.');
  assert.equal(replayed[0].prose, live[0].prose);
  assert.equal(messageBody(live[0]), messageBody(replayed[0]));
});

// Invariant: events a sub-agent emits (parentToolUseId) never form, extend or receive anything of a message, and
// events without a seq (history_gap) are ignored.
test('sub-agent events and seq-less events never form or extend a message', () => {
  const messages = assembleMessages([
    { ...envelope('main', [textBlock('conductor')]), _seq: 1 },
    { ...envelope('sub', [textBlock('sub-agent chatter')], { parentToolUseId: 'toolu_x' }), _seq: 2 },
    { ...delta('main', 0, '!', { parentToolUseId: 'toolu_x' }), _seq: 3 },
    { kind: 'plan_request', toolUseId: 'p', plan: 'sub plan', parentToolUseId: 'toolu_x', _seq: 4 },
    { kind: 'history_gap' },
    delta('noseq', 0, 'no seq on this one'),
  ]);
  assert.deepEqual(messages.map((m) => [m.msgId, m.prose, m.hasPlan]), [['main', 'conductor', false]]);
});

// Invariant: a plan_request (auto-approved included) and a user_question attach to the message that owns their
// toolUseId, not to whatever came last; a plan with no text still yields the fence header; segments follow the order
// their blocks first occurred.
test('plans and questions attach by toolUseId and render in arrival order', () => {
  const messages = assembleMessages(seq([
    { kind: 'tool_use', msgId: 'a', blockIdx: 0, toolUseId: 'plan-1', name: 'ExitPlanMode', input: {} },
    delta('a', 1, 'Trailing prose.'),
    delta('b', 0, 'Other message.'),
    { kind: 'plan_request', toolUseId: 'plan-1', plan: 'The plan', planPath: '/p.md', autoApproved: true },
    { kind: 'tool_use', msgId: 'c', blockIdx: 0, toolUseId: 'q-1', name: 'AskUserQuestion', input: {} },
    { kind: 'user_question', toolUseId: 'q-1', questions: QUESTIONS },
    { kind: 'tool_use', msgId: 'd', blockIdx: 0, toolUseId: 'plan-2', name: 'ExitPlanMode', input: {} },
    { kind: 'plan_request', toolUseId: 'plan-2', plan: null, planPath: '/gone.md' },
  ]));
  const [a, b, c, d] = messages;
  assert.equal(messageBody(a), '--- plan · saved to /p.md ---\nThe plan\nTrailing prose.', 'the plan block came before the prose');
  assert.equal(b.hasPlan, false);
  assert.equal(c.questions.length, 1);
  assert.match(messageBody(c), /^--- questions ---\n1\. Pick\? \(multiSelect: false\) · header: P\n   - A: first$/);
  assert.equal(messageBody(d), '--- plan · saved to /gone.md ---');
});

// Invariant: only narration-flagged thinking renders, under its own fence, each block trimmed and blank-line joined;
// unflagged thinking never appears.
test('narration renders under its fence and plain thinking never does', () => {
  const [m] = assembleMessages(seq([
    { kind: 'thinking_delta', msgId: 'n', blockIdx: 0, text: 'private reasoning' },
    { kind: 'thinking_delta', msgId: 'n', blockIdx: 1, text: '  Looking at the files.  ', narration: true },
    { kind: 'thinking_delta', msgId: 'n', blockIdx: 2, text: ' Now the tests. ', narration: true },
    delta('n', 3, 'Done.'),
  ]));
  assert.equal(messageBody(m), '--- narration ---\nLooking at the files.\n\nNow the tests.\nDone.');
  assert.deepEqual(assembleMessages(seq([{ kind: 'thinking_delta', msgId: 'only', blockIdx: 0, text: 'just thinking' }])), [], 'a message with nothing to show is dropped');
});

// Invariant: the selection bonds the last prose message back, within its own turn, to the nearest plan-or-questions
// message, and never across a turn_end; a last message that carries its own ask is returned alone.
test('bondedSelection bonds within the turn and never across a turn_end', () => {
  const ask = (msgId) => [delta(msgId, 0, 'asking'), { kind: 'tool_use', msgId, toolUseId: `t-${msgId}`, name: 'AskUserQuestion', input: {} }, { kind: 'user_question', toolUseId: `t-${msgId}`, questions: QUESTIONS }];
  const ids = (events) => bondedSelection(assembleMessages(seq(events))).map((m) => m.msgId);
  assert.deepEqual(ids([...ask('q'), delta('p1', 0, 'one'), delta('p2', 0, 'two')]), ['q', 'p1', 'p2']);
  assert.deepEqual(ids([...ask('q'), { kind: 'turn_end' }, delta('p1', 0, 'one')]), ['p1'], 'the question belongs to an earlier turn');
  assert.deepEqual(ids([delta('p0', 0, 'zero'), ...ask('q')]), ['q'], 'a last message with its own ask is alone');
  assert.deepEqual(ids([delta('p0', 0, 'zero'), delta('p1', 0, 'one')]), ['p1'], 'no ask in the turn');
  assert.deepEqual(ids([]), []);
});

// Invariant: a key is `<seq>-<msgId>` with a safe-integer seq; anything else parses to null.
test('parseMessageKey accepts <seq>-<msgId> and nothing else', () => {
  assert.deepEqual(parseMessageKey('12-msg_01AbC'), { seq: 12, msgId: 'msg_01AbC' });
  assert.deepEqual(parseMessageKey('0-m'), { seq: 0, msgId: 'm' });
  assert.deepEqual(parseMessageKey('7-a-b-c'), { seq: 7, msgId: 'a-b-c' }, 'only the first dash splits');
  for (const bad of ['', '-m', '1-', 'x-m', '1x-m', '12', ' 1-m', '-1-m', '1.5-m', '9'.repeat(16) + '-m', 7, null, undefined, {}]) {
    assert.equal(parseMessageKey(bad), null, JSON.stringify(bad));
  }
});

// Invariant: in a window cut at its old end, the oldest message is left out unless its message_start is in the window,
// whichever of its events the window begins on (a block opener, a text_end, a delta); a message that opened inside the
// window, and any message in a window the host has nothing older than, is never left out.
test('wholeMessages leaves out the oldest message unless the window holds its start', () => {
  const second = [delta('a', 2, 'SECOND '), { kind: 'message_start', msgId: 'b' }, delta('b', 0, 'whole b')];
  const seams = {
    thinking_start: { kind: 'thinking_start', msgId: 'a', blockIdx: 1 },
    tool_use_start: { kind: 'tool_use_start', msgId: 'a', blockIdx: 1 },
    text_end: { kind: 'text_end', msgId: 'a', blockIdx: 0 },
    text_delta: delta('a', 0, 'FIRST '),
  };
  for (const [name, seam] of Object.entries(seams)) {
    const events = seq([seam, ...second]);
    const { messages, partial } = wholeMessages(events, false);
    assert.deepEqual(messages.map((m) => m.msgId), ['b'], name);
    assert.equal(partial.msgId, 'a', name);
    assert.deepEqual(wholeMessages(events, true).messages.map((m) => m.msgId), ['a', 'b'], `${name}: nothing older`);
  }
  const opened = seq([{ kind: 'message_start', msgId: 'a' }, delta('a', 0, 'whole a'), { kind: 'message_start', msgId: 'b' }, delta('b', 0, 'whole b')]);
  assert.deepEqual(wholeMessages(opened, false).messages.map((m) => m.msgId), ['a', 'b']);
  assert.deepEqual(wholeMessages([], false), { messages: [], partial: null });
});

// Invariant: a message's first seq is its first event of any kind, so a window that begins on a non-content event of
// a message (a block opener) starts that message there, not at its first delta.
test('a message first seq is its first event of any kind', () => {
  const [m] = assembleMessages(seq([{ kind: 'thinking_start', msgId: 'a', blockIdx: 1 }, delta('a', 2, 'text')]));
  assert.deepEqual([m.firstSeq, m.key, m.opened], [1, '1-a', false]);
});
