// Pure mapping from what the user said to the host's `answer_question`
// payload. The host matches option labels byte for byte, so spoken choices
// (an option number or its words) are resolved to the exact label here.
//
// A spoken entry is {choices?: string[], text?: string, note?: string}, aligned
// to the pending questions in order. Every refusal is
// {code, question, choice?, offered?, message} and is returned, not thrown.

const ORDINAL = /^\s*(?:option\s*)?(\d+)\s*$/i;

function normalize(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const dropParenthetical = (s) => s.replace(/\s*\([^()]*\)\s*$/, '');

// The index of the option `choice` names, or -1 for none, or -2 for several.
// First rung that matches anything decides.
function findOption(choice, labels) {
  const exact = labels.indexOf(choice);
  if (exact >= 0) return exact;
  const ordinal = ORDINAL.exec(choice);
  if (ordinal) {
    const i = Number(ordinal[1]) - 1;
    return i >= 0 && i < labels.length ? i : -1;
  }
  const want = normalize(choice);
  if (want === '') return -1;
  const rungs = [
    (l) => normalize(l) === want,
    (l) => normalize(dropParenthetical(l)) === want,
    (l) => normalize(dropParenthetical(l)).includes(want),
  ];
  for (const matches of rungs) {
    const hits = [];
    labels.forEach((l, i) => { if (matches(l)) hits.push(i); });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return -2;
  }
  return -1;
}

function offeredList(labels) {
  return labels.map((l, i) => `${i + 1}. ${l}`).join('; ');
}

// One question's answer, `n` its 1-based position, `labels` its option labels.
function resolveEntry(entry, n, labels, multiSelect) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const note = typeof e.note === 'string' && e.note.trim() ? { note: e.note } : {};
  if (typeof e.text === 'string' && e.text.trim()) return { answer: { text: e.text } };
  const choices = Array.isArray(e.choices) ? e.choices : [];
  if (choices.length === 0) return { answer: {} };
  if (!multiSelect && choices.length > 1) {
    return { refusal: { code: 'TOO_MANY_CHOICES', question: n, offered: labels, message: `Question ${n} takes one choice, but ${choices.length} were given. Options: ${offeredList(labels)}.` } };
  }
  const picked = [];
  for (const choice of choices) {
    const i = findOption(String(choice), labels);
    if (i < 0) {
      return { refusal: { code: 'INVALID_OPTION', question: n, choice: String(choice), offered: labels, message: `${i === -2 ? 'Several options match' : 'No option matches'} "${choice}" for question ${n}. Options: ${offeredList(labels)}.` } };
    }
    if (!picked.includes(labels[i])) picked.push(labels[i]);
  }
  return { answer: multiSelect ? { options: picked, ...note } : { option: picked[0], ...note } };
}

// `questions` is the pending AskUserQuestion's questions, or null when they
// could not be read: choices then pass through verbatim for the host to judge.
export function resolveAnswers(questions, spoken) {
  const given = Array.isArray(spoken) ? spoken : [];
  if (questions === null) {
    return {
      answers: given.map((e) => {
        const choices = Array.isArray(e?.choices) ? e.choices : [];
        if (typeof e?.text === 'string' && e.text.trim()) return { text: e.text };
        const note = typeof e?.note === 'string' && e.note.trim() ? { note: e.note } : {};
        if (choices.length === 0) return {};
        return choices.length === 1 ? { option: String(choices[0]), ...note } : { options: choices.map(String), ...note };
      }),
    };
  }
  if (given.length > questions.length) {
    return { refusal: { code: 'ANSWER_COUNT_MISMATCH', expected: questions.length, got: given.length, message: `There are ${questions.length} question(s) but ${given.length} answers were given.` } };
  }
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const labels = (questions[i]?.options ?? []).map((o) => o.label);
    const r = resolveEntry(given[i], i + 1, labels, !!questions[i]?.multiSelect);
    if (r.refusal) return r;
    answers.push(r.answer);
  }
  return { answers };
}

// What was sent, for the tool result: the non-empty answers by question number.
export function describeAnswers(answers) {
  return answers
    .map((a, i) => ({ question: i + 1, answer: a.text ?? a.options ?? (a.option !== undefined ? [a.option] : null) }))
    .filter((d) => d.answer !== null);
}

// Re-resolves one spoken entry against the labels the host says it offers.
// `i` is the 0-based question index the host reported.
export function remapQuestion(i, entry, offered, multiSelect) {
  return resolveEntry(entry, i + 1, offered, multiSelect);
}
