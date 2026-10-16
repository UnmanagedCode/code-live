// The conversation transcript as data: entries the Transcript component
// renders as text. Same surface as the session view and announcements expect:
// add, appendStream, endTurn, divider.
//
// Every event costs O(1): entries are appended in place, a streamed chunk
// replaces only its own entry object (every other entry keeps its identity),
// and listeners are told which part changed. The list of ids changes only when
// an entry is added; one entry's subscribers hear only about that entry.

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
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Map<number, number>} */
  const position = new Map(); // entry id -> its index in `entries`
  const listListeners = new Set(); // an entry was added
  /** @type {Map<number, Set<() => void>>} */
  const entryListeners = new Map(); // one entry changed
  let nextId = 1;
  let stream = null; // {kind, id} of the bubble currently receiving chunks
  /** @type {number[] | null} */
  let idsCopy = null; // the ids array getIds hands out, rebuilt after an add

  const call = (set) => { for (const fn of [...set]) fn(); };

  /** @param {Entry} entry */
  function push(entry) {
    position.set(entry.id, entries.push(entry) - 1);
    idsCopy = null;
    call(listListeners);
    return entry.id;
  }

  /** @param {(() => void)} fn @param {Set<() => void>} set */
  const listen = (set, fn) => { set.add(fn); return () => { set.delete(fn); }; };

  return {
    /** Entries added (not chunks). */
    subscribeIds: (/** @type {() => void} */ fn) => listen(listListeners, fn),
    /** The entry ids, in order: the same array until an entry is added. @returns {number[]} */
    getIds: () => (idsCopy ??= entries.map((e) => e.id)),

    /** Changes to entry `id` only. */
    subscribeEntry(/** @type {number} */ id, /** @type {() => void} */ fn) {
      let set = entryListeners.get(id);
      if (!set) entryListeners.set(id, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) entryListeners.delete(id);
      };
    },
    /** @param {number} id @returns {Entry | undefined} */
    getEntry: (id) => { const at = position.get(id); return at === undefined ? undefined : entries[at]; },

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

    // Merges consecutive transcription chunks of one speaker into one bubble;
    // anything added ends the stream. The chunk goes to its bubble by id, and
    // the stream is set before push() notifies, so a listener that re-enters the
    // store during that notification cannot split or misplace the bubble.
    /** @param {string} kind @param {string} chunk */
    appendStream(kind, chunk) {
      if (!STREAMED.has(kind)) return this.add(kind, chunk);
      let id;
      if (stream && stream.kind === kind) {
        id = stream.id;
      } else {
        id = nextId++;
        stream = { kind, id };
        push({ id, kind, label: LABELS[kind], body: '', mono: false });
      }
      const at = /** @type {number} */ (position.get(id));
      const prev = /** @type {Message} */ (entries[at]);
      entries[at] = { ...prev, body: prev.body + String(chunk) };
      const set = entryListeners.get(id);
      if (set) call(set);
      return id;
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
