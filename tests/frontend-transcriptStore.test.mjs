// Pins the transcript's data: each entry's kind, label (kind, then title, ask
// and name) and body (verbatim text, or JSON text for tool payloads); streamed
// transcription chunks merge per speaker until the turn ends, and any add or
// divider ends the stream; entries keep their order and stable ids.
// Rendering them as text is pinned by Transcript.test.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptStore } from '../frontend/src/lib/transcriptStore.js';

const HOSTILE = ['<img src=x onerror=alert(1)>', '</pre><script>x</script>', '"><svg onload=alert(1)>'];

test('every kind keeps hostile payloads verbatim, tool payloads as JSON text', () => {
  const tr = createTranscriptStore();
  for (const kind of ['you', 'gemini', 'conductor', 'status', 'error', 'tool_call', 'tool_result']) {
    for (const p of HOSTILE) {
      const id = tr.add(kind, kind.startsWith('tool') ? { args: p } : p, { title: p, name: p });
      const entry = tr.getSnapshot().find((e) => e.id === id);
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
  assert.deepEqual(tr.getSnapshot().map((e) => e.label), ['Conductor · Alpha · plan', 'Tool call · list_conductor_sessions', 'Status', 'custom_kind']);
});

test('a tool payload JSON cannot encode renders as the text undefined; other content is stringified', () => {
  const tr = createTranscriptStore();
  tr.add('tool_result', undefined);
  tr.add('status', 42);
  assert.deepEqual(tr.getSnapshot().map((e) => e.body), ['undefined', '42']);
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
  const entries = tr.getSnapshot();
  assert.deepEqual(entries.map((e) => e.body), ['Hello', 'Hi', 'Again', 'x', 'after status']);
  assert.deepEqual(entries.map((e) => e.kind), ['you', 'gemini', 'gemini', 'status', 'gemini']);
  assert.deepEqual(entries.map((e) => e.label), ['You', 'Gemini', 'Gemini', 'Status', 'Gemini']);
});

test('a chunk of a non-streamed kind is added as its own entry', () => {
  const tr = createTranscriptStore();
  tr.appendStream('gemini', 'a');
  tr.appendStream('status', 's');
  tr.appendStream('gemini', 'b');
  assert.deepEqual(tr.getSnapshot().map((e) => [e.kind, e.body]), [['gemini', 'a'], ['status', 's'], ['gemini', 'b']]);
});

test('divider keeps its text and ends the streamed bubble', () => {
  const tr = createTranscriptStore();
  for (const p of HOSTILE) tr.divider(p);
  assert.deepEqual(tr.getSnapshot().map((e) => [e.kind, e.text]), HOSTILE.map((p) => ['divider', p]));

  tr.appendStream('gemini', 'a');
  const d = tr.divider('x');
  tr.appendStream('gemini', 'b');
  const entries = tr.getSnapshot();
  const gemini = entries.filter((e) => e.kind === 'gemini');
  assert.deepEqual(gemini.map((e) => e.body), ['a', 'b']);
  const at = (id) => entries.findIndex((e) => e.id === id);
  assert.ok(at(gemini[0].id) < at(d) && at(d) < at(gemini[1].id));
});

test('every change publishes a new snapshot and notifies subscribers; ids stay unique', () => {
  const tr = createTranscriptStore();
  let calls = 0;
  const off = tr.subscribe(() => { calls++; });
  const s0 = tr.getSnapshot();
  tr.appendStream('gemini', 'a');
  const s1 = tr.getSnapshot();
  tr.appendStream('gemini', 'b');
  const s2 = tr.getSnapshot();
  assert.notEqual(s0, s1);
  assert.notEqual(s1, s2);
  assert.equal(s1[0].body, 'a', 'an earlier snapshot is not mutated');
  assert.equal(s2[0].id, s1[0].id, 'a streamed chunk keeps the entry id');
  tr.add('status', 'x');
  tr.divider('d');
  assert.equal(calls, 5);
  off();
  tr.add('status', 'y');
  assert.equal(calls, 5);
  const ids = tr.getSnapshot().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
