// The conversation transcript. Every string is rendered as DOM text.
import { el } from './dom.js';

const LABELS = {
  you: 'You',
  gemini: 'Gemini',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  conductor: 'Conductor',
  status: 'Status',
  error: 'Error',
};
const STREAMED = new Set(['you', 'gemini']);
const JSON_KINDS = new Set(['tool_call', 'tool_result']);

export function createTranscript(root) {
  let stream = null; // {kind, body} of the bubble currently receiving chunks

  function scroll() { root.scrollTop = root.scrollHeight; }

  function entry(kind, label, body) {
    const node = el('div', { class: `entry entry-${kind}` }, [el('div', { class: 'entry-label' }, label), body]);
    root.append(node);
    scroll();
    return node;
  }

  return {
    // meta.title labels conductor entries (meta.ask adds `question` or `plan`);
    // meta.name labels tool entries.
    add(kind, content, meta = {}) {
      stream = null;
      let label = LABELS[kind] ?? kind;
      if (meta.title) label += ` · ${meta.title}`;
      if (meta.ask) label += ` · ${meta.ask}`;
      if (meta.name) label += ` · ${meta.name}`;
      const body = JSON_KINDS.has(kind)
        ? el('pre', { class: 'entry-body' }, JSON.stringify(content, null, 2) ?? 'undefined')
        : el('div', { class: 'entry-body' }, String(content));
      return entry(kind, label, body);
    },

    // Merges consecutive transcription chunks of one speaker into one bubble.
    appendStream(kind, chunk) {
      if (!STREAMED.has(kind)) return this.add(kind, chunk);
      if (!stream || stream.kind !== kind) {
        const body = el('div', { class: 'entry-body' });
        entry(kind, LABELS[kind], body);
        stream = { kind, body };
      }
      stream.body.append(chunk);
      scroll();
      return stream.body.parentNode;
    },

    endTurn() { stream = null; },
  };
}
