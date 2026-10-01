// Pins: model-written content of every kind renders as inert text (hostile
// markup creates no elements), tool payloads render as JSON text, and
// transcription chunks merge per speaker until the turn ends. A divider is
// inert text and ends the streamed bubble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';

const HOSTILE = ['<img src=x onerror=alert(1)>', '</pre><script>x</script>', '"><svg onload=alert(1)>'];

test('every kind renders hostile payloads as text', async () => {
  const { document, createTranscript } = await loadDom('transcript.js');
  const root = document.createElement('div');
  const tr = createTranscript(root);
  for (const kind of ['you', 'gemini', 'conductor', 'status', 'error', 'tool_call', 'tool_result']) {
    for (const p of HOSTILE) {
      const node = tr.add(kind, kind.startsWith('tool') ? { args: p } : p, { title: p, name: p });
      const body = node.querySelector('.entry-body');
      if (kind.startsWith('tool')) {
        assert.equal(body.tagName, 'PRE');
        assert.equal(body.textContent, JSON.stringify({ args: p }, null, 2));
      } else {
        assert.equal(body.textContent, p);
      }
      assert.ok(node.querySelector('.entry-label').textContent.includes(p));
    }
  }
  for (const p of HOSTILE) tr.appendStream('gemini', p);
  assert.equal(root.querySelectorAll('img,script,svg').length, 0);
});

test('stream chunks merge per speaker until endTurn', async () => {
  const { document, createTranscript } = await loadDom('transcript.js');
  const root = document.createElement('div');
  const tr = createTranscript(root);
  const a = tr.appendStream('you', 'Hel');
  const b = tr.appendStream('you', 'lo');
  assert.ok(a === b);
  const g = tr.appendStream('gemini', 'Hi');
  assert.ok(g !== a);
  tr.endTurn();
  const g2 = tr.appendStream('gemini', 'Again');
  assert.ok(g2 !== g);
  tr.add('status', 'x');
  const g3 = tr.appendStream('gemini', 'after status');
  assert.ok(g3 !== g2);
  assert.deepEqual([...root.querySelectorAll('.entry-body')].map((e) => e.textContent), ['Hello', 'Hi', 'Again', 'x', 'after status']);
  assert.deepEqual([...root.children].map((e) => e.className), ['entry entry-you', 'entry entry-gemini', 'entry entry-gemini', 'entry entry-status', 'entry entry-gemini']);
});

test('divider renders text inertly and ends the streamed bubble', async () => {
  const { document, createTranscript } = await loadDom('transcript.js');
  const root = document.createElement('div');
  const tr = createTranscript(root);
  for (const p of HOSTILE) {
    const node = tr.divider(p);
    assert.equal(node.textContent, p);
    assert.equal(node.className, 'divider');
  }
  assert.equal(root.querySelectorAll('img,script,svg').length, 0);

  tr.appendStream('gemini', 'a');
  const d = tr.divider('x');
  tr.appendStream('gemini', 'b');
  const gemini = [...root.querySelectorAll('.entry-gemini')];
  assert.deepEqual(gemini.map((e) => e.querySelector('.entry-body').textContent), ['a', 'b']);
  const kids = [...root.children];
  assert.ok(kids.indexOf(gemini[0]) < kids.indexOf(d) && kids.indexOf(d) < kids.indexOf(gemini[1]));
});
