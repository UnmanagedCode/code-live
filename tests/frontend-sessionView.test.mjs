// Pins: a reply renders as one Gemini bubble per real turn end: an
// IN_PROGRESS turnComplete keeps the bubble open, a missing/null/IDLE status
// closes it; interruptions flush the speaker. A new-session divider is added
// only when a connect attempt goes live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionView, isReplyEnd } from '../frontend/src/lib/sessionView.js';
import { createTranscriptStore } from '../frontend/src/lib/transcriptStore.js';

async function setup(now) {
  const transcript = createTranscriptStore();
  const played = [];
  let flushed = 0;
  const view = createSessionView({ now, transcript, player: { enqueue: (b) => played.push(b), flush: () => { flushed++; } } });
  const entries = () => transcript.getIds().map((id) => transcript.getEntry(id));
  const bubbles = () => entries().filter((e) => e.kind === 'gemini').map((e) => e.body);
  return { view, entries, bubbles, played, flushed: () => flushed, isReplyEnd };
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
  const { view, entries } = await setup(() => fixed);
  const feed = (...states) => states.forEach((state) => view.handle({ type: 'state', state }));
  const dividers = () => entries().filter((e) => e.kind === 'divider');
  feed('connecting', 'live');
  assert.deepEqual(dividers().map((d) => d.text), [`New session started · ${fixed.toLocaleTimeString()}`]);
  feed('reconnecting', 'live');
  assert.equal(dividers().length, 1);
  feed('idle', 'connecting', 'error');
  assert.equal(dividers().length, 1);
  feed('connecting', 'live');
  assert.equal(dividers().length, 2);
});
