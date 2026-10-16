// Pins the transcript's data: each entry's kind, label (kind, then title, ask
// and name) and body (verbatim text, or JSON text for tool payloads); streamed
// transcription chunks merge per speaker until the turn ends, and any add or
// divider ends the stream; entries keep their order and stable ids. A store
// update replaces only the entry it changes (every other entry keeps its object
// identity), tells only that entry's subscribers and leaves the id list alone
// on a chunk, and costs the same however long the transcript is. A listener
// that re-enters the store during a notification extends the same bubble.
// Rendering them as text is pinned by Transcript.test.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptStore } from '../frontend/src/lib/transcriptStore.js';

// The entries in order, read the way the Transcript component reads them.
const entriesOf = (tr) => tr.getIds().map((id) => tr.getEntry(id));

const HOSTILE = ['<img src=x onerror=alert(1)>', '</pre><script>x</script>', '"><svg onload=alert(1)>'];

test('every kind keeps hostile payloads verbatim, tool payloads as JSON text', () => {
  const tr = createTranscriptStore();
  for (const kind of ['you', 'gemini', 'conductor', 'status', 'error', 'tool_call', 'tool_result']) {
    for (const p of HOSTILE) {
      const id = tr.add(kind, kind.startsWith('tool') ? { args: p } : p, { title: p, name: p });
      const entry = tr.getEntry(id);
      assert.equal(entry.kind, kind);
      if (kind.startsWith('tool')) {
        assert.equal(entry.mono, true);
        assert.equal(entry.body, JSON.stringify({ args: p }, null, 2));
      } else {
        assert.equal(entry.mono, false);
        assert.equal(entry.body, p);
      }
      assert.ok(entry.label.includes(p));
    }
  }
});

test('labels: the kind, then title, ask and name in that order', () => {
  const tr = createTranscriptStore();
  tr.add('conductor', 'x', { title: 'Alpha', ask: 'plan' });
  tr.add('tool_call', {}, { name: 'list_conductor_sessions' });
  tr.add('status', 'x');
  tr.add('custom_kind', 'x');
  assert.deepEqual(entriesOf(tr).map((e) => e.label), ['Conductor · Alpha · plan', 'Tool call · list_conductor_sessions', 'Status', 'custom_kind']);
});

test('a tool payload JSON cannot encode renders as the text undefined; other content is stringified', () => {
  const tr = createTranscriptStore();
  tr.add('tool_result', undefined);
  tr.add('status', 42);
  assert.deepEqual(entriesOf(tr).map((e) => e.body), ['undefined', '42']);
});

test('stream chunks merge per speaker until endTurn', () => {
  const tr = createTranscriptStore();
  const a = tr.appendStream('you', 'Hel');
  const b = tr.appendStream('you', 'lo');
  assert.equal(a, b);
  const g = tr.appendStream('gemini', 'Hi');
  assert.notEqual(g, a);
  tr.endTurn();
  const g2 = tr.appendStream('gemini', 'Again');
  assert.notEqual(g2, g);
  tr.add('status', 'x');
  const g3 = tr.appendStream('gemini', 'after status');
  assert.notEqual(g3, g2);
  const entries = entriesOf(tr);
  assert.deepEqual(entries.map((e) => e.body), ['Hello', 'Hi', 'Again', 'x', 'after status']);
  assert.deepEqual(entries.map((e) => e.kind), ['you', 'gemini', 'gemini', 'status', 'gemini']);
  assert.deepEqual(entries.map((e) => e.label), ['You', 'Gemini', 'Gemini', 'Status', 'Gemini']);
});

test('a chunk of a non-streamed kind is added as its own entry', () => {
  const tr = createTranscriptStore();
  tr.appendStream('gemini', 'a');
  tr.appendStream('status', 's');
  tr.appendStream('gemini', 'b');
  assert.deepEqual(entriesOf(tr).map((e) => [e.kind, e.body]), [['gemini', 'a'], ['status', 's'], ['gemini', 'b']]);
});

test('divider keeps its text and ends the streamed bubble', () => {
  const tr = createTranscriptStore();
  for (const p of HOSTILE) tr.divider(p);
  assert.deepEqual(entriesOf(tr).map((e) => [e.kind, e.text]), HOSTILE.map((p) => ['divider', p]));

  tr.appendStream('gemini', 'a');
  const d = tr.divider('x');
  tr.appendStream('gemini', 'b');
  const entries = entriesOf(tr);
  const gemini = entries.filter((e) => e.kind === 'gemini');
  assert.deepEqual(gemini.map((e) => e.body), ['a', 'b']);
  const at = (id) => entries.findIndex((e) => e.id === id);
  assert.ok(at(gemini[0].id) < at(d) && at(d) < at(gemini[1].id));
});

test('every change notifies its subscribers with a new value; ids stay unique', () => {
  const tr = createTranscriptStore();
  let lists = 0;
  let chunks = 0;
  const offIds = tr.subscribeIds(() => { lists++; });
  const i0 = tr.getIds();
  const g = tr.appendStream('gemini', 'a');
  const i1 = tr.getIds();
  assert.notEqual(i1, i0, 'a new bubble publishes a new id list');
  assert.equal(lists, 1);
  const e1 = tr.getEntry(g);
  const offEntry = tr.subscribeEntry(g, () => { chunks++; });
  assert.equal(tr.appendStream('gemini', 'b'), g, 'a streamed chunk keeps the entry id');
  const e2 = tr.getEntry(g);
  assert.notEqual(e2, e1, 'a chunk publishes a new entry object');
  assert.equal(e1.body, 'a', 'an earlier entry object is not mutated');
  assert.equal(e2.id, e1.id);
  assert.equal(e2.body, 'ab');
  assert.equal(chunks, 1);
  tr.add('status', 'x');
  tr.divider('d');
  assert.deepEqual([lists, chunks], [3, 1], 'each change told its own channel once');
  offIds();
  offEntry();
  tr.add('status', 'y');
  assert.deepEqual([lists, chunks], [3, 1]);
  const ids = tr.getIds();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(tr.getIds(), ids, 'repeated reads return the same array');
});

test('a chunk replaces only the streaming entry: the others keep their identity, the id list stays, only its subscribers hear', () => {
  const tr = createTranscriptStore();
  tr.add('status', 'a');
  tr.divider('d');
  const g = tr.appendStream('gemini', 'Hel');
  const before = entriesOf(tr);
  const ids = tr.getIds();
  const heard = { list: 0, gemini: 0, other: 0 };
  tr.subscribeIds(() => heard.list++);
  tr.subscribeEntry(g, () => heard.gemini++);
  tr.subscribeEntry(before[0].id, () => heard.other++);

  tr.appendStream('gemini', 'lo');
  const after = entriesOf(tr);
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.notEqual(after[2], before[2]);
  assert.equal(after[2].body, 'Hello');
  assert.equal(before[2].body, 'Hel', 'the replaced entry object is not mutated');
  assert.equal(tr.getEntry(g), after[2]);
  assert.equal(tr.getIds(), ids, 'a chunk does not change the id list');
  assert.deepEqual(heard, { list: 0, gemini: 1, other: 0 });

  tr.add('error', 'x');
  const added = entriesOf(tr);
  for (let i = 0; i < 3; i++) assert.equal(added[i], after[i], `entry ${i} keeps its identity across an add`);
  assert.notEqual(tr.getIds(), ids);
  assert.deepEqual(tr.getIds(), [...ids, added[3].id]);
  assert.deepEqual(heard, { list: 1, gemini: 1, other: 0 });
});

test('an unsubscribed entry listener hears nothing more', () => {
  const tr = createTranscriptStore();
  const g = tr.appendStream('gemini', 'a');
  let n = 0;
  const off = tr.subscribeEntry(g, () => n++);
  tr.appendStream('gemini', 'b');
  off();
  tr.appendStream('gemini', 'c');
  assert.equal(n, 1);
});

test('per-event cost does not grow with the transcript', () => {
  // 2,000 chunks and 2,000 adds on a transcript of 5,000 entries and of 80,000.
  const time = (size) => {
    const tr = createTranscriptStore();
    for (let i = 0; i < size; i++) tr.add('status', 'x');
    // Listeners on both channels, so the cost includes notifying them.
    tr.subscribeIds(() => {});
    tr.subscribeEntry(size + 1, () => {}); // the first bubble the chunks below create
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t = performance.now();
      for (let i = 0; i < 2000; i++) tr.appendStream('gemini', 'chunk ');
      for (let i = 0; i < 2000; i++) tr.add('status', 'y');
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const small = time(5_000);
  const large = time(80_000);
  assert.ok(large < 100, `80k entries: ${large.toFixed(1)} ms for 4,000 events`);
  if (small >= 2) assert.ok(large / small < 3, `16x the entries cost ${(large / small).toFixed(1)}x (${small.toFixed(1)} vs ${large.toFixed(1)} ms)`);
});

test('a listener re-entering appendStream during the new bubble\'s notification extends the same bubble', () => {
  const tr = createTranscriptStore();
  let reentered = 0;
  tr.subscribeIds(() => { if (reentered++ === 0) tr.appendStream('gemini', 'inner '); });
  const g = tr.appendStream('gemini', 'outer');
  assert.equal(reentered, 1, 'the list listener ran once: no second bubble was announced');
  assert.deepEqual(entriesOf(tr).map((e) => [e.id, e.kind, e.body]), [[g, 'gemini', 'inner outer']]);
});

test("a listener re-entering appendStream during a chunk's notification extends the same bubble", () => {
  const tr = createTranscriptStore();
  const g = tr.appendStream('gemini', 'a');
  let reentered = 0;
  tr.subscribeEntry(g, () => { if (reentered++ === 0) tr.appendStream('gemini', 'c'); });
  tr.appendStream('gemini', 'b');
  assert.deepEqual(entriesOf(tr).map((e) => [e.id, e.body]), [[g, 'abc']]);
});

test("an entry added during a new bubble's notification does not take that bubble's chunk", () => {
  const tr = createTranscriptStore();
  let added = 0;
  tr.subscribeIds(() => { if (added++ === 0) tr.add('status', 'meanwhile'); });
  const g = tr.appendStream('gemini', 'spoken');
  assert.deepEqual(entriesOf(tr).map((e) => [e.kind, e.body]), [['gemini', 'spoken'], ['status', 'meanwhile']]);
  assert.equal(tr.getEntry(g).body, 'spoken');
});
