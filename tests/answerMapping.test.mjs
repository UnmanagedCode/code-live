// Pins: spoken choices resolve to the host's byte-exact option labels through
// the documented ladder (exact, number, normalized, parenthetical dropped,
// unique partial), an unresolvable or ambiguous choice is refused with the
// offered options instead of guessed, and padding/over-count/multi-select/text
// follow the host's answer shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswers, remapQuestion, describeAnswers } from '../src/answerMapping.js';

const opts = (...labels) => labels.map((label) => ({ label, description: `${label} desc` }));
const single = (...labels) => ({ question: 'Which?', header: 'H', multiSelect: false, options: opts(...labels) });
const multi = (...labels) => ({ question: 'Which ones?', header: 'H', multiSelect: true, options: opts(...labels) });
const one = (questions, choice) => resolveAnswers(questions, [{ choices: [choice] }]);

test('each rung of the ladder maps to the exact label', () => {
  const q = [single('Postgres (Recommended)', 'SQLite', 'Redis: fast cache', 'Two words')];
  const cases = [
    ['SQLite', 'SQLite', 'exact'],
    ['Redis: fast cache', 'Redis: fast cache', 'exact with a colon'],
    ['2', 'SQLite', 'number'],
    ['option 3', 'Redis: fast cache', '"option N"'],
    [' 1 ', 'Postgres (Recommended)', 'number with spaces'],
    ['sqlite', 'SQLite', 'case'],
    ['redis fast cache', 'Redis: fast cache', 'punctuation'],
    ['two   WORDS!', 'Two words', 'whitespace and case'],
    ['postgres', 'Postgres (Recommended)', 'parenthetical dropped'],
    ['Postgres (recommended)', 'Postgres (Recommended)', 'normalized with parenthetical'],
    ['lite', 'SQLite', 'unique partial'],
    ['cache', 'Redis: fast cache', 'unique containment'],
  ];
  for (const [said, label, why] of cases) {
    assert.deepEqual(one(q, said), { answers: [{ option: label }] }, why);
  }
});

test('a number that is itself a label wins over the ordinal', () => {
  assert.deepEqual(one([single('one', '2', 'three')], '2'), { answers: [{ option: '2' }] });
});

test('an unknown, out-of-range or ambiguous choice is refused with the offered labels', () => {
  const q = [single('Red apple', 'Green apple', 'Banana')];
  for (const said of ['mango', '4', '0', 'apple', '   ', '!!!']) {
    const r = one(q, said);
    assert.equal(r.refusal.code, 'INVALID_OPTION', said);
    assert.equal(r.refusal.question, 1);
    assert.deepEqual(r.refusal.offered, ['Red apple', 'Green apple', 'Banana']);
    assert.match(r.refusal.message, /1\. Red apple; 2\. Green apple; 3\. Banana/);
  }
  assert.match(one(q, 'apple').refusal.message, /^Several options match/);
  assert.match(one(q, 'mango').refusal.message, /^No option matches/);
});

test('single-choice takes one choice; multiSelect takes several, deduplicated', () => {
  const single2 = resolveAnswers([single('A', 'B')], [{ choices: ['A', 'B'] }]);
  assert.equal(single2.refusal.code, 'TOO_MANY_CHOICES');
  assert.deepEqual(single2.refusal.offered, ['A', 'B']);
  const m = resolveAnswers([multi('Lint', 'Test', 'Build')], [{ choices: ['1', 'test', 'Lint'], note: 'both please' }]);
  assert.deepEqual(m, { answers: [{ options: ['Lint', 'Test'], note: 'both please' }] });
  assert.deepEqual(resolveAnswers([multi('Lint', 'Test')], [{ choices: ['Test'] }]), { answers: [{ options: ['Test'] }] }, 'a single pick on a multiSelect is still options');
});

test('text, note and empty entries follow the host answer shape', () => {
  const qs = [single('A', 'B'), single('C', 'D'), single('E', 'F')];
  const r = resolveAnswers(qs, [{ text: 'something else', choices: ['A'] }, { choices: ['d'], note: 'because' }, {}]);
  assert.deepEqual(r, { answers: [{ text: 'something else' }, { option: 'D', note: 'because' }, {}] });
  assert.deepEqual(resolveAnswers(qs, [{ note: 'orphan note' }]).answers, [{}, {}, {}], 'a note alone sends nothing');
});

test('missing trailing entries are skipped; extra entries are refused', () => {
  const qs = [single('A', 'B'), single('C', 'D')];
  assert.deepEqual(resolveAnswers(qs, [{ choices: ['B'] }]), { answers: [{ option: 'B' }, {}] });
  const over = resolveAnswers(qs, [{}, {}, {}]);
  assert.deepEqual(over.refusal, { code: 'ANSWER_COUNT_MISMATCH', expected: 2, got: 3, message: 'There are 2 question(s) but 3 answers were given.' });
});

test('the question number in a refusal is 1-based', () => {
  const r = resolveAnswers([single('A'), single('B', 'C')], [{}, { choices: ['nope'] }]);
  assert.equal(r.refusal.question, 2);
  assert.deepEqual(r.refusal.offered, ['B', 'C']);
});

test('unreadable questions pass the spoken choices through verbatim', () => {
  assert.deepEqual(resolveAnswers(null, [{ choices: ['2'] }, { choices: ['a', 'b'], note: 'n' }, { text: 't' }, {}]), {
    answers: [{ option: '2' }, { options: ['a', 'b'], note: 'n' }, { text: 't' }, {}],
  });
});

test('remapQuestion re-resolves one entry against the host-offered labels', () => {
  assert.deepEqual(remapQuestion(1, { choices: ['beta'] }, ['Alpha', 'Beta (new)'], false), { answer: { option: 'Beta (new)' } });
  assert.deepEqual(remapQuestion(0, { choices: ['1', 'gamma'] }, ['Alpha', 'Gamma'], true), { answer: { options: ['Alpha', 'Gamma'] } });
  const r = remapQuestion(2, { choices: ['zzz'] }, ['Alpha'], false);
  assert.equal(r.refusal.question, 3);
  assert.deepEqual(r.refusal.offered, ['Alpha']);
});

test('describeAnswers lists only the non-empty answers by question number', () => {
  assert.deepEqual(describeAnswers([{ option: 'A' }, {}, { options: ['X', 'Y'] }, { text: 'free' }]), [
    { question: 1, answer: ['A'] },
    { question: 3, answer: ['X', 'Y'] },
    { question: 4, answer: 'free' },
  ]);
});
