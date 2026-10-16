// The conversation transcript as data: entries the Transcript component
// renders as text. Same surface as the session view and announcements expect:
// add, appendStream, endTurn, divider.
import { createStore } from './store.js';

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

/**
 * @typedef {{ id: number, kind: string, label: string, body: string, mono: boolean }} Message
 * @typedef {{ id: number, kind: 'divider', text: string }} Divider
 * @typedef {Message | Divider} Entry
 */

export function createTranscriptStore() {
  const store = createStore({ entries: /** @type {Entry[]} */ ([]) });
  let nextId = 1;
  let stream = null; // {kind, id} of the bubble currently receiving chunks

  /** @param {Entry} entry */
  function push(entry) {
    store.set({ entries: [...store.get().entries, entry] });
    return entry.id;
  }

  return {
    subscribe: store.subscribe,
    getSnapshot: () => store.get().entries,

    // meta.title labels conductor entries (meta.ask adds `question` or `plan`);
    // meta.name labels tool entries.
    /** @param {string} kind @param {unknown} content @param {{ title?: string, ask?: string, name?: string }} [meta] */
    add(kind, content, meta = {}) {
      stream = null;
      let label = LABELS[kind] ?? kind;
      if (meta.title) label += ` · ${meta.title}`;
      if (meta.ask) label += ` · ${meta.ask}`;
      if (meta.name) label += ` · ${meta.name}`;
      const mono = JSON_KINDS.has(kind);
      const body = mono ? JSON.stringify(content, null, 2) ?? 'undefined' : String(content);
      return push({ id: nextId++, kind, label, body, mono });
    },

    // Merges consecutive transcription chunks of one speaker into one bubble.
    // The streamed bubble is always the last entry: anything added ends the stream.
    /** @param {string} kind @param {string} chunk */
    appendStream(kind, chunk) {
      if (!STREAMED.has(kind)) return this.add(kind, chunk);
      if (!stream || stream.kind !== kind) {
        stream = { kind, id: push({ id: nextId++, kind, label: LABELS[kind], body: '', mono: false }) };
      }
      const entries = store.get().entries;
      const last = /** @type {Message} */ (entries[entries.length - 1]);
      store.set({ entries: [...entries.slice(0, -1), { ...last, body: last.body + String(chunk) }] });
      return stream.id;
    },

    endTurn() { stream = null; },

    // A full-width line marking a new session; the next chunk starts a new bubble below it.
    /** @param {string} text */
    divider(text) {
      stream = null;
      return push({ id: nextId++, kind: 'divider', text: String(text) });
    },
  };
}
