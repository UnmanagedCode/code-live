// Pins: a reply renders as one Gemini bubble per real turn end: an
// IN_PROGRESS turnComplete keeps the bubble open, a missing/null/IDLE status
// closes it; interruptions flush the speaker. A new-session divider is added
// only when a connect attempt goes live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';

async function setup(now) {
  const { document, createTranscript, createSessionView, isReplyEnd } = await loadDom('transcript.js', 'sessionView.js');
  const root = document.createElement('div');
  const played = [];
  let flushed = 0;
  const view = createSessionView({ now, transcript: createTranscript(root), player: { enqueue: (b) => played.push(b), flush: () => { flushed++; } } });
  const bubbles = () => [...root.querySelectorAll('.entry-gemini .entry-body')].map((e) => e.textContent);
  return { view, root, bubbles, played, flushed: () => flushed, isReplyEnd };
}

test('isReplyEnd: only IN_PROGRESS is not an end', async () => {
  const { isReplyEnd } = await setup();
  assert.equal(isReplyEnd({ interactionStatus: 'IN_PROGRESS' }), false);
  for (const s of [undefined, null, 'IDLE']) assert.equal(isReplyEnd({ interactionStatus: s }), true, String(s));
});

test('an IN_PROGRESS turn keeps one bubble; a real end starts a new one', async () => {
  const { view, bubbles } = await setup();
  view.handle({ type: 'output_transcript', text: 'Let me check. ' });
  view.handle({ type: 'turn_complete', interactionStatus: 'IN_PROGRESS' });
  view.handle({ type: 'output_transcript', text: 'Found two sessions.' });
  view.handle({ type: 'turn_complete', interactionStatus: 'IDLE' });
  view.handle({ type: 'output_transcript', text: 'Next reply.' });
  view.handle({ type: 'turn_complete', interactionStatus: null });
  view.handle({ type: 'output_transcript', text: 'Third.' });
  view.handle({ type: 'turn_complete' });
  view.handle({ type: 'output_transcript', text: 'Fourth.' });
  assert.deepEqual(bubbles(), ['Let me check. Found two sessions.', 'Next reply.', 'Third.', 'Fourth.']);
});

test('audio plays, interruptions flush and end the bubble', async () => {
  const { view, bubbles, played, flushed } = await setup();
  view.handle({ type: 'audio', data: 'AAA=' });
  view.handle({ type: 'output_transcript', text: 'Talking' });
  view.handle({ type: 'interrupted' });
  view.handle({ type: 'output_transcript', text: 'After' });
  assert.deepEqual(played, ['AAA=']);
  assert.equal(flushed(), 1);
  assert.deepEqual(bubbles(), ['Talking', 'After']);
});

test('connecting → live adds one divider with the time; a resume and other states add none', async () => {
  const fixed = new Date(2026, 0, 2, 3, 4, 5);
  const { view, root } = await setup(() => fixed);
  const feed = (...states) => states.forEach((state) => view.handle({ type: 'state', state }));
  const dividers = () => [...root.querySelectorAll('.divider')];
  feed('connecting', 'live');
  assert.deepEqual(dividers().map((d) => d.textContent), [`New session started · ${fixed.toLocaleTimeString()}`]);
  feed('reconnecting', 'live');
  assert.equal(dividers().length, 1);
  feed('idle', 'connecting', 'error');
  assert.equal(dividers().length, 1);
  feed('connecting', 'live');
  assert.equal(dividers().length, 2);
});
