// Pins: a reply renders as one Gemini bubble per real turn end: an
// IN_PROGRESS turnComplete keeps the bubble open, a missing/null/IDLE status
// closes it; interruptions flush the speaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDom } from './dom.mjs';

async function setup() {
  const { document, createTranscript, createSessionView, isReplyEnd } = await loadDom('transcript.js', 'sessionView.js');
  const root = document.createElement('div');
  const played = [];
  let flushed = 0;
  const view = createSessionView({ transcript: createTranscript(root), player: { enqueue: (b) => played.push(b), flush: () => { flushed++; } } });
  const bubbles = () => [...root.querySelectorAll('.entry-gemini .entry-body')].map((e) => e.textContent);
  return { view, bubbles, played, flushed: () => flushed, isReplyEnd };
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
