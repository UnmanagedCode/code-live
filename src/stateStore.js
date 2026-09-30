// Persistent runtime state at <dataDir>/state.json: the active conductor
// target, the _seq of the last turn_end already announced for it and the msgId
// of that turn's last assistant message (the key that survives a host ring reset).
import path from 'node:path';
import { writeFileAtomic, readJson } from './atomicFile.js';

const EMPTY = { activeTargetId: null, lastHandledTurnSeq: -1, lastHandledMsgId: null };

// `write` is injectable so tests can make write completion order observable.
export function createStateStore({ dir, write = writeFileAtomic }) {
  const file = path.join(dir, 'state.json');
  let state = { ...EMPTY };
  let writing = Promise.resolve(); // serializes writes so the file ends in update order

  return {
    file,
    async load() {
      const data = await readJson(file);
      if (data === null) { state = { ...EMPTY }; return state; }
      if (typeof data !== 'object'
        || !(data.activeTargetId === null || typeof data.activeTargetId === 'string')
        || typeof data.lastHandledTurnSeq !== 'number'
        || !(data.lastHandledMsgId === undefined || data.lastHandledMsgId === null || typeof data.lastHandledMsgId === 'string')) {
        throw Object.assign(new Error('state.json is malformed'), { code: 'STORE_CORRUPT' });
      }
      state = { activeTargetId: data.activeTargetId, lastHandledTurnSeq: data.lastHandledTurnSeq, lastHandledMsgId: data.lastHandledMsgId ?? null };
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
