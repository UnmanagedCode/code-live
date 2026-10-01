// Persistent runtime state at <dataDir>/state.json: the announced conductors,
// keyed by instance id. Each entry holds the _seq of the last turn_end already
// announced for that conductor, the msgId of that turn's last assistant message
// (the key that survives a host ring reset), and the tool_use id of the last
// question or plan announced. Fields of any other shape are ignored on load.
import path from 'node:path';
import { writeFileAtomic, readJson } from './atomicFile.js';

const EMPTY = { watched: {} };

const optionalString = (v) => v === undefined || v === null || typeof v === 'string';

const corrupt = () => Object.assign(new Error('state.json is malformed'), { code: 'STORE_CORRUPT' });

function parseWatched(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  return Object.fromEntries(Object.entries(value).map(([id, e]) => {
    if (!e || typeof e !== 'object' || typeof e.lastHandledTurnSeq !== 'number'
      || !optionalString(e.lastHandledMsgId) || !optionalString(e.lastHandledAskId)) throw corrupt();
    return [id, { lastHandledTurnSeq: e.lastHandledTurnSeq, lastHandledMsgId: e.lastHandledMsgId ?? null, lastHandledAskId: e.lastHandledAskId ?? null }];
  }));
}

// `write` is injectable so tests can make write completion order observable.
export function createStateStore({ dir, write = writeFileAtomic }) {
  const file = path.join(dir, 'state.json');
  let state = { ...EMPTY };
  let writing = Promise.resolve(); // serializes writes so the file ends in update order

  return {
    file,
    async load() {
      const data = await readJson(file);
      if (data === null) { state = { watched: {} }; return state; }
      if (typeof data !== 'object' || Array.isArray(data)) throw corrupt();
      state = { watched: parseWatched(data.watched) };
      return state;
    },
    get() { return { ...state }; },
    async update(patch) {
      state = { ...state, ...patch };
      const snapshot = JSON.stringify(state);
      writing = writing.catch(() => {}).then(() => write(file, snapshot));
      await writing;
      return { ...state };
    },
  };
}
